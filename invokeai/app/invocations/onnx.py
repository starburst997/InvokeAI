# Copyright (c) 2023 Borisov Sergey (https://github.com/StAlKeR7779)

import inspect
import re
from contextlib import ExitStack
from typing import List, Literal, Optional, Union

import numpy as np
import torch
from diffusers import ControlNetModel, DPMSolverMultistepScheduler
from diffusers.image_processor import VaeImageProcessor
from diffusers.schedulers import SchedulerMixin as Scheduler
from pydantic import BaseModel, Field, validator
from tqdm import tqdm

from invokeai.app.invocations.metadata import CoreMetadata
from invokeai.app.invocations.primitives import ConditioningField, ConditioningOutput, ImageField, ImageOutput
from invokeai.app.util.step_callback import stable_diffusion_step_callback
from invokeai.backend import BaseModelType, ModelType, SubModelType

from ...backend.model_management import ONNXModelPatcher
from ...backend.stable_diffusion import PipelineIntermediateState
from ...backend.util import choose_torch_device
from ..models.image import ImageCategory, ResourceOrigin
from .baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    FieldDescriptions,
    InputField,
    Input,
    InvocationContext,
    OutputField,
    UIComponent,
    UIType,
    tags,
    title,
)
from .controlnet_image_processors import ControlField
from .latent import SAMPLER_NAME_VALUES, LatentsField, LatentsOutput, build_latents_output, get_scheduler
from .model import ClipField, ModelInfo, UNetField, VaeField

ORT_TO_NP_TYPE = {
    "tensor(bool)": np.bool_,
    "tensor(int8)": np.int8,
    "tensor(uint8)": np.uint8,
    "tensor(int16)": np.int16,
    "tensor(uint16)": np.uint16,
    "tensor(int32)": np.int32,
    "tensor(uint32)": np.uint32,
    "tensor(int64)": np.int64,
    "tensor(uint64)": np.uint64,
    "tensor(float16)": np.float16,
    "tensor(float)": np.float32,
    "tensor(double)": np.float64,
}

PRECISION_VALUES = Literal[tuple(list(ORT_TO_NP_TYPE.keys()))]


@title("ONNX Prompt (Raw)")
@tags("onnx", "prompt")
class ONNXPromptInvocation(BaseInvocation):
    type: Literal["prompt_onnx"] = "prompt_onnx"

    prompt: str = InputField(default="", description=FieldDescriptions.raw_prompt, ui_component=UIComponent.Textarea)
    clip: ClipField = InputField(description=FieldDescriptions.clip, input=Input.Connection)

    def invoke(self, context: InvocationContext) -> ConditioningOutput:
        tokenizer_info = context.services.model_manager.get_model(
            **self.clip.tokenizer.dict(),
        )
        text_encoder_info = context.services.model_manager.get_model(
            **self.clip.text_encoder.dict(),
        )
        with tokenizer_info as orig_tokenizer, text_encoder_info as text_encoder, ExitStack() as stack:
            loras = [
                (context.services.model_manager.get_model(**lora.dict(exclude={"weight"})).context.model, lora.weight)
                for lora in self.clip.loras
            ]

            ti_list = []
            for trigger in re.findall(r"<[a-zA-Z0-9., _-]+>", self.prompt):
                name = trigger[1:-1]
                try:
                    ti_list.append(
                        (
                            name,
                            context.services.model_manager.get_model(
                                model_name=name,
                                base_model=self.clip.text_encoder.base_model,
                                model_type=ModelType.TextualInversion,
                            ).context.model,
                        )
                    )
                except Exception:
                    # print(e)
                    # import traceback
                    # print(traceback.format_exc())
                    print(f'Warn: trigger: "{trigger}" not found')
            if loras or ti_list:
                text_encoder.release_session()
            with ONNXModelPatcher.apply_lora_text_encoder(text_encoder, loras), ONNXModelPatcher.apply_ti(
                orig_tokenizer, text_encoder, ti_list
            ) as (tokenizer, ti_manager):
                text_encoder.create_session()

                # copy from
                # https://github.com/huggingface/diffusers/blob/3ebbaf7c96801271f9e6c21400033b6aa5ffcf29/src/diffusers/pipelines/stable_diffusion/pipeline_onnx_stable_diffusion.py#L153
                text_inputs = tokenizer(
                    self.prompt,
                    padding="max_length",
                    max_length=tokenizer.model_max_length,
                    truncation=True,
                    return_tensors="np",
                )
                text_input_ids = text_inputs.input_ids
                """
                untruncated_ids = tokenizer(prompt, padding="max_length", return_tensors="np").input_ids

                if not np.array_equal(text_input_ids, untruncated_ids):
                    removed_text = self.tokenizer.batch_decode(
                        untruncated_ids[:, self.tokenizer.model_max_length - 1 : -1]
                    )
                    logger.warning(
                        "The following part of your input was truncated because CLIP can only handle sequences up to"
                        f" {self.tokenizer.model_max_length} tokens: {removed_text}"
                    )
                """

                prompt_embeds = text_encoder(input_ids=text_input_ids.astype(np.int32))[0]

        conditioning_name = f"{context.graph_execution_state_id}_{self.id}_conditioning"

        # TODO: hacky but works ;D maybe rename latents somehow?
        context.services.latents.save(conditioning_name, (prompt_embeds, None))

        return ConditioningOutput(
            conditioning=ConditioningField(
                conditioning_name=conditioning_name,
            ),
        )


# Text to image
@title("ONNX Text to Latents")
@tags("latents", "inference", "txt2img", "onnx")
class ONNXTextToLatentsInvocation(BaseInvocation):
    """Generates latents from conditionings."""

    type: Literal["t2l_onnx"] = "t2l_onnx"

    # Inputs
    positive_conditioning: ConditioningField = InputField(
        description=FieldDescriptions.positive_cond,
        input=Input.Connection,
    )
    negative_conditioning: ConditioningField = InputField(
        description=FieldDescriptions.negative_cond,
        input=Input.Connection,
    )
    noise: LatentsField = InputField(
        description=FieldDescriptions.noise,
        input=Input.Connection,
    )
    steps: int = InputField(default=10, gt=0, description=FieldDescriptions.steps)
    cfg_scale: Union[float, List[float]] = InputField(
        default=7.5,
        ge=1,
        description=FieldDescriptions.cfg_scale,
        ui_type=UIType.Float,
    )
    scheduler: SAMPLER_NAME_VALUES = InputField(
        default="euler", description=FieldDescriptions.scheduler, input=Input.Direct
    )
    precision: PRECISION_VALUES = InputField(default="tensor(float16)", description=FieldDescriptions.precision)
    unet: UNetField = InputField(
        description=FieldDescriptions.unet,
        input=Input.Connection,
    )
    control: Optional[Union[ControlField, list[ControlField]]] = InputField(
        default=None,
        description=FieldDescriptions.control,
        ui_type=UIType.Control,
    )
    # seamless:   bool = InputField(default=False, description="Whether or not to generate an image that can tile without seams", )
    # seamless_axes: str = InputField(default="", description="The axes to tile the image on, 'x' and/or 'y'")

    @validator("cfg_scale")
    def ge_one(cls, v):
        """validate that all cfg_scale values are >= 1"""
        if isinstance(v, list):
            for i in v:
                if i < 1:
                    raise ValueError("cfg_scale must be greater than 1")
        else:
            if v < 1:
                raise ValueError("cfg_scale must be greater than 1")
        return v

    # based on
    # https://github.com/huggingface/diffusers/blob/3ebbaf7c96801271f9e6c21400033b6aa5ffcf29/src/diffusers/pipelines/stable_diffusion/pipeline_onnx_stable_diffusion.py#L375
    def invoke(self, context: InvocationContext) -> LatentsOutput:
        c, _ = context.services.latents.get(self.positive_conditioning.conditioning_name)
        uc, _ = context.services.latents.get(self.negative_conditioning.conditioning_name)
        graph_execution_state = context.services.graph_execution_manager.get(context.graph_execution_state_id)
        source_node_id = graph_execution_state.prepared_source_mapping[self.id]
        if isinstance(c, torch.Tensor):
            c = c.cpu().numpy()
        if isinstance(uc, torch.Tensor):
            uc = uc.cpu().numpy()
        device = torch.device(choose_torch_device())
        prompt_embeds = np.concatenate([uc, c])

        latents = context.services.latents.get(self.noise.latents_name)
        if isinstance(latents, torch.Tensor):
            latents = latents.cpu().numpy()

        # TODO: better execution device handling
        latents = latents.astype(ORT_TO_NP_TYPE[self.precision])

        # get the initial random noise unless the user supplied it
        do_classifier_free_guidance = True
        # latents_dtype = prompt_embeds.dtype
        # latents_shape = (batch_size * num_images_per_prompt, 4, height // 8, width // 8)
        # if latents.shape != latents_shape:
        #    raise ValueError(f"Unexpected latents shape, got {latents.shape}, expected {latents_shape}")

        scheduler = get_scheduler(
            context=context,
            scheduler_info=self.unet.scheduler,
            scheduler_name=self.scheduler,
            seed=0,  # TODO: refactor this node
        )

        def torch2numpy(latent: torch.Tensor):
            return latent.cpu().numpy()

        def numpy2torch(latent, device):
            return torch.from_numpy(latent).to(device)

        def dispatch_progress(
            self, context: InvocationContext, source_node_id: str, intermediate_state: PipelineIntermediateState
        ) -> None:
            stable_diffusion_step_callback(
                context=context,
                intermediate_state=intermediate_state,
                node=self.dict(),
                source_node_id=source_node_id,
            )

        scheduler.set_timesteps(self.steps)
        latents = latents * np.float64(scheduler.init_noise_sigma)

        extra_step_kwargs = dict()
        if "eta" in set(inspect.signature(scheduler.step).parameters.keys()):
            extra_step_kwargs.update(
                eta=0.0,
            )

        unet_info = context.services.model_manager.get_model(**self.unet.unet.dict())

        with unet_info as unet, ExitStack() as stack:
            # loras = [(stack.enter_context(context.services.model_manager.get_model(**lora.dict(exclude={"weight"}))), lora.weight) for lora in self.unet.loras]
            loras = [
                (context.services.model_manager.get_model(**lora.dict(exclude={"weight"})).context.model, lora.weight)
                for lora in self.unet.loras
            ]

            if loras:
                unet.release_session()
            with ONNXModelPatcher.apply_lora_unet(unet, loras):
                # TODO:
                _, _, h, w = latents.shape
                unet.create_session(h, w)

                timestep_dtype = next(
                    (input.type for input in unet.session.get_inputs() if input.name == "timestep"), "tensor(float16)"
                )
                timestep_dtype = ORT_TO_NP_TYPE[timestep_dtype]
                for i in tqdm(range(len(scheduler.timesteps))):
                    t = scheduler.timesteps[i]
                    # expand the latents if we are doing classifier free guidance
                    latent_model_input = np.concatenate([latents] * 2) if do_classifier_free_guidance else latents
                    latent_model_input = scheduler.scale_model_input(numpy2torch(latent_model_input, device), t)
                    latent_model_input = latent_model_input.cpu().numpy()

                    # predict the noise residual
                    timestep = np.array([t], dtype=timestep_dtype)
                    noise_pred = unet(sample=latent_model_input, timestep=timestep, encoder_hidden_states=prompt_embeds)
                    noise_pred = noise_pred[0]

                    # perform guidance
                    if do_classifier_free_guidance:
                        noise_pred_uncond, noise_pred_text = np.split(noise_pred, 2)
                        noise_pred = noise_pred_uncond + self.cfg_scale * (noise_pred_text - noise_pred_uncond)

                    # compute the previous noisy sample x_t -> x_t-1
                    scheduler_output = scheduler.step(
                        numpy2torch(noise_pred, device), t, numpy2torch(latents, device), **extra_step_kwargs
                    )
                    latents = torch2numpy(scheduler_output.prev_sample)

                    state = PipelineIntermediateState(
                        run_id="test", step=i, timestep=timestep, latents=scheduler_output.prev_sample
                    )
                    dispatch_progress(self, context=context, source_node_id=source_node_id, intermediate_state=state)

                    # call the callback, if provided
                    # if callback is not None and i % callback_steps == 0:
                    #    callback(i, t, latents)

        torch.cuda.empty_cache()

        name = f"{context.graph_execution_state_id}__{self.id}"
        context.services.latents.save(name, latents)
        return build_latents_output(latents_name=name, latents=torch.from_numpy(latents))


# Latent to image
@title("ONNX Latents to Image")
@tags("latents", "image", "vae", "onnx")
class ONNXLatentsToImageInvocation(BaseInvocation):
    """Generates an image from latents."""

    type: Literal["l2i_onnx"] = "l2i_onnx"

    # Inputs
    latents: LatentsField = InputField(
        description=FieldDescriptions.denoised_latents,
        input=Input.Connection,
    )
    vae: VaeField = InputField(
        description=FieldDescriptions.vae,
        input=Input.Connection,
    )
    metadata: Optional[CoreMetadata] = InputField(
        default=None,
        description=FieldDescriptions.core_metadata,
        ui_hidden=True,
    )
    # tiled: bool = InputField(default=False, description="Decode latents by overlaping tiles(less memory consumption)")

    def invoke(self, context: InvocationContext) -> ImageOutput:
        latents = context.services.latents.get(self.latents.latents_name)

        if self.vae.vae.submodel != SubModelType.VaeDecoder:
            raise Exception(f"Expected vae_decoder, found: {self.vae.vae.model_type}")

        vae_info = context.services.model_manager.get_model(
            **self.vae.vae.dict(),
        )

        # clear memory as vae decode can request a lot
        torch.cuda.empty_cache()

        with vae_info as vae:
            vae.create_session()

            # copied from
            # https://github.com/huggingface/diffusers/blob/3ebbaf7c96801271f9e6c21400033b6aa5ffcf29/src/diffusers/pipelines/stable_diffusion/pipeline_onnx_stable_diffusion.py#L427
            latents = 1 / 0.18215 * latents
            # image = self.vae_decoder(latent_sample=latents)[0]
            # it seems likes there is a strange result for using half-precision vae decoder if batchsize>1
            image = np.concatenate([vae(latent_sample=latents[i : i + 1])[0] for i in range(latents.shape[0])])

            image = np.clip(image / 2 + 0.5, 0, 1)
            image = image.transpose((0, 2, 3, 1))
            image = VaeImageProcessor.numpy_to_pil(image)[0]

        torch.cuda.empty_cache()

        image_dto = context.services.images.create(
            image=image,
            image_origin=ResourceOrigin.INTERNAL,
            image_category=ImageCategory.GENERAL,
            node_id=self.id,
            session_id=context.graph_execution_state_id,
            is_intermediate=self.is_intermediate,
            metadata=self.metadata.dict() if self.metadata else None,
        )

        return ImageOutput(
            image=ImageField(image_name=image_dto.image_name),
            width=image_dto.width,
            height=image_dto.height,
        )


class ONNXModelLoaderOutput(BaseInvocationOutput):
    """Model loader output"""

    # fmt: off
    type: Literal["model_loader_output_onnx"] = "model_loader_output_onnx"

    unet: UNetField = OutputField(default=None, description=FieldDescriptions.unet, title="UNet")
    clip: ClipField = OutputField(default=None, description=FieldDescriptions.clip, title="CLIP")
    vae_decoder: VaeField = OutputField(default=None, description=FieldDescriptions.vae, title="VAE Decoder")
    vae_encoder: VaeField = OutputField(default=None, description=FieldDescriptions.vae, title="VAE Encoder")
    # fmt: on


class OnnxModelField(BaseModel):
    """Onnx model field"""

    model_name: str = Field(description="Name of the model")
    base_model: BaseModelType = Field(description="Base model")
    model_type: ModelType = Field(description="Model Type")


@title("ONNX Model Loader")
@tags("onnx", "model")
class OnnxModelLoaderInvocation(BaseInvocation):
    """Loads a main model, outputting its submodels."""

    type: Literal["onnx_model_loader"] = "onnx_model_loader"

    # Inputs
    model: OnnxModelField = InputField(
        description=FieldDescriptions.onnx_main_model, input=Input.Direct, ui_type=UIType.ONNXModel
    )

    def invoke(self, context: InvocationContext) -> ONNXModelLoaderOutput:
        base_model = self.model.base_model
        model_name = self.model.model_name
        model_type = ModelType.ONNX

        # TODO: not found exceptions
        if not context.services.model_manager.model_exists(
            model_name=model_name,
            base_model=base_model,
            model_type=model_type,
        ):
            raise Exception(f"Unknown {base_model} {model_type} model: {model_name}")

        """
        if not context.services.model_manager.model_exists(
            model_name=self.model_name,
            model_type=SDModelType.Diffusers,
            submodel=SDModelType.Tokenizer,
        ):
            raise Exception(
                f"Failed to find tokenizer submodel in {self.model_name}! Check if model corrupted"
            )

        if not context.services.model_manager.model_exists(
            model_name=self.model_name,
            model_type=SDModelType.Diffusers,
            submodel=SDModelType.TextEncoder,
        ):
            raise Exception(
                f"Failed to find text_encoder submodel in {self.model_name}! Check if model corrupted"
            )

        if not context.services.model_manager.model_exists(
            model_name=self.model_name,
            model_type=SDModelType.Diffusers,
            submodel=SDModelType.UNet,
        ):
            raise Exception(
                f"Failed to find unet submodel from {self.model_name}! Check if model corrupted"
            )
        """

        return ONNXModelLoaderOutput(
            unet=UNetField(
                unet=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.UNet,
                ),
                scheduler=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.Scheduler,
                ),
                loras=[],
            ),
            clip=ClipField(
                tokenizer=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.Tokenizer,
                ),
                text_encoder=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.TextEncoder,
                ),
                loras=[],
                skipped_layers=0,
            ),
            vae_decoder=VaeField(
                vae=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.VaeDecoder,
                ),
            ),
            vae_encoder=VaeField(
                vae=ModelInfo(
                    model_name=model_name,
                    base_model=base_model,
                    model_type=model_type,
                    submodel=SubModelType.VaeEncoder,
                ),
            ),
        )
