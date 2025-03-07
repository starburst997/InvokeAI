import { logger } from 'app/logging/logger';
import { RootState } from 'app/store/store';
import { NonNullableGraph } from 'features/nodes/types/types';
import {
  ImageBlurInvocation,
  ImageDTO,
  ImageToLatentsInvocation,
  InfillPatchMatchInvocation,
  InfillTileInvocation,
  NoiseInvocation,
  RandomIntInvocation,
  RangeOfSizeInvocation,
} from 'services/api/types';
import { addControlNetToLinearGraph } from './addControlNetToLinearGraph';
import { addNSFWCheckerToGraph } from './addNSFWCheckerToGraph';
import { addSDXLLoRAsToGraph } from './addSDXLLoRAstoGraph';
import { addSDXLRefinerToGraph } from './addSDXLRefinerToGraph';
import { addVAEToGraph } from './addVAEToGraph';
import { addWatermarkerToGraph } from './addWatermarkerToGraph';
import {
  CANVAS_OUTPUT,
  COLOR_CORRECT,
  INPAINT_IMAGE,
  INPAINT_IMAGE_RESIZE_DOWN,
  INPAINT_IMAGE_RESIZE_UP,
  INPAINT_INFILL,
  INPAINT_INFILL_RESIZE_DOWN,
  ITERATE,
  LATENTS_TO_IMAGE,
  MASK_BLUR,
  MASK_COMBINE,
  MASK_FROM_ALPHA,
  MASK_RESIZE_DOWN,
  MASK_RESIZE_UP,
  NEGATIVE_CONDITIONING,
  NOISE,
  POSITIVE_CONDITIONING,
  RANDOM_INT,
  RANGE_OF_SIZE,
  SDXL_CANVAS_OUTPAINT_GRAPH,
  SDXL_DENOISE_LATENTS,
  SDXL_MODEL_LOADER,
} from './constants';
import { craftSDXLStylePrompt } from './helpers/craftSDXLStylePrompt';

/**
 * Builds the Canvas tab's Outpaint graph.
 */
export const buildCanvasSDXLOutpaintGraph = (
  state: RootState,
  canvasInitImage: ImageDTO,
  canvasMaskImage?: ImageDTO
): NonNullableGraph => {
  const log = logger('nodes');
  const {
    positivePrompt,
    negativePrompt,
    model,
    cfgScale: cfg_scale,
    scheduler,
    steps,
    iterations,
    seed,
    shouldRandomizeSeed,
    vaePrecision,
    shouldUseNoiseSettings,
    shouldUseCpuNoise,
    maskBlur,
    maskBlurMethod,
    tileSize,
    infillMethod,
  } = state.generation;

  const {
    sdxlImg2ImgDenoisingStrength: strength,
    shouldUseSDXLRefiner,
    refinerStart,
    shouldConcatSDXLStylePrompt,
  } = state.sdxl;

  if (!model) {
    log.error('No model found in state');
    throw new Error('No model found in state');
  }

  // The bounding box determines width and height, not the width and height params
  const { width, height } = state.canvas.boundingBoxDimensions;

  // We may need to set the inpaint width and height to scale the image
  const {
    scaledBoundingBoxDimensions,
    boundingBoxScaleMethod,
    shouldAutoSave,
  } = state.canvas;

  const use_cpu = shouldUseNoiseSettings
    ? shouldUseCpuNoise
    : shouldUseCpuNoise;

  // Construct Style Prompt
  const { craftedPositiveStylePrompt, craftedNegativeStylePrompt } =
    craftSDXLStylePrompt(state, shouldConcatSDXLStylePrompt);

  const graph: NonNullableGraph = {
    id: SDXL_CANVAS_OUTPAINT_GRAPH,
    nodes: {
      [SDXL_MODEL_LOADER]: {
        type: 'sdxl_model_loader',
        id: SDXL_MODEL_LOADER,
        model,
      },
      [POSITIVE_CONDITIONING]: {
        type: 'sdxl_compel_prompt',
        id: POSITIVE_CONDITIONING,
        prompt: positivePrompt,
        style: craftedPositiveStylePrompt,
      },
      [NEGATIVE_CONDITIONING]: {
        type: 'sdxl_compel_prompt',
        id: NEGATIVE_CONDITIONING,
        prompt: negativePrompt,
        style: craftedNegativeStylePrompt,
      },
      [MASK_FROM_ALPHA]: {
        type: 'tomask',
        id: MASK_FROM_ALPHA,
        is_intermediate: true,
        image: canvasInitImage,
      },
      [MASK_COMBINE]: {
        type: 'mask_combine',
        id: MASK_COMBINE,
        is_intermediate: true,
        mask2: canvasMaskImage,
      },
      [MASK_BLUR]: {
        type: 'img_blur',
        id: MASK_BLUR,
        is_intermediate: true,
        radius: maskBlur,
        blur_type: maskBlurMethod,
      },
      [INPAINT_INFILL]: {
        type: 'infill_tile',
        id: INPAINT_INFILL,
        is_intermediate: true,
        tile_size: tileSize,
      },
      [INPAINT_IMAGE]: {
        type: 'i2l',
        id: INPAINT_IMAGE,
        is_intermediate: true,
        fp32: vaePrecision === 'fp32' ? true : false,
      },
      [NOISE]: {
        type: 'noise',
        id: NOISE,
        use_cpu,
        is_intermediate: true,
      },
      [SDXL_DENOISE_LATENTS]: {
        type: 'denoise_latents',
        id: SDXL_DENOISE_LATENTS,
        is_intermediate: true,
        steps: steps,
        cfg_scale: cfg_scale,
        scheduler: scheduler,
        denoising_start: shouldUseSDXLRefiner
          ? Math.min(refinerStart, 1 - strength)
          : 1 - strength,
        denoising_end: shouldUseSDXLRefiner ? refinerStart : 1,
      },
      [LATENTS_TO_IMAGE]: {
        type: 'l2i',
        id: LATENTS_TO_IMAGE,
        is_intermediate: true,
        fp32: vaePrecision === 'fp32' ? true : false,
      },
      [COLOR_CORRECT]: {
        type: 'color_correct',
        id: COLOR_CORRECT,
        is_intermediate: true,
      },
      [CANVAS_OUTPUT]: {
        type: 'img_paste',
        id: CANVAS_OUTPUT,
        is_intermediate: !shouldAutoSave,
      },
      [RANGE_OF_SIZE]: {
        type: 'range_of_size',
        id: RANGE_OF_SIZE,
        is_intermediate: true,
        // seed - must be connected manually
        // start: 0,
        size: iterations,
        step: 1,
      },
      [ITERATE]: {
        type: 'iterate',
        id: ITERATE,
        is_intermediate: true,
      },
    },
    edges: [
      // Connect Model Loader To UNet and CLIP
      {
        source: {
          node_id: SDXL_MODEL_LOADER,
          field: 'unet',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'unet',
        },
      },
      {
        source: {
          node_id: SDXL_MODEL_LOADER,
          field: 'clip',
        },
        destination: {
          node_id: POSITIVE_CONDITIONING,
          field: 'clip',
        },
      },
      {
        source: {
          node_id: SDXL_MODEL_LOADER,
          field: 'clip2',
        },
        destination: {
          node_id: POSITIVE_CONDITIONING,
          field: 'clip2',
        },
      },
      {
        source: {
          node_id: SDXL_MODEL_LOADER,
          field: 'clip',
        },
        destination: {
          node_id: NEGATIVE_CONDITIONING,
          field: 'clip',
        },
      },
      {
        source: {
          node_id: SDXL_MODEL_LOADER,
          field: 'clip2',
        },
        destination: {
          node_id: NEGATIVE_CONDITIONING,
          field: 'clip2',
        },
      },
      // Connect Infill Result To Inpaint Image
      {
        source: {
          node_id: INPAINT_INFILL,
          field: 'image',
        },
        destination: {
          node_id: INPAINT_IMAGE,
          field: 'image',
        },
      },
      // Combine Mask from Init Image with User Painted Mask
      {
        source: {
          node_id: MASK_FROM_ALPHA,
          field: 'image',
        },
        destination: {
          node_id: MASK_COMBINE,
          field: 'mask1',
        },
      },
      // Connect Everything To Inpaint
      {
        source: {
          node_id: POSITIVE_CONDITIONING,
          field: 'conditioning',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'positive_conditioning',
        },
      },
      {
        source: {
          node_id: NEGATIVE_CONDITIONING,
          field: 'conditioning',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'negative_conditioning',
        },
      },
      {
        source: {
          node_id: NOISE,
          field: 'noise',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'noise',
        },
      },
      {
        source: {
          node_id: INPAINT_IMAGE,
          field: 'latents',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'latents',
        },
      },
      {
        source: {
          node_id: MASK_BLUR,
          field: 'image',
        },
        destination: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'mask',
        },
      },
      // Iterate
      {
        source: {
          node_id: RANGE_OF_SIZE,
          field: 'collection',
        },
        destination: {
          node_id: ITERATE,
          field: 'collection',
        },
      },
      {
        source: {
          node_id: ITERATE,
          field: 'item',
        },
        destination: {
          node_id: NOISE,
          field: 'seed',
        },
      },
      // Decode inpainted latents to image
      {
        source: {
          node_id: SDXL_DENOISE_LATENTS,
          field: 'latents',
        },
        destination: {
          node_id: LATENTS_TO_IMAGE,
          field: 'latents',
        },
      },
    ],
  };

  // Add Infill Nodes

  if (infillMethod === 'patchmatch') {
    graph.nodes[INPAINT_INFILL] = {
      type: 'infill_patchmatch',
      id: INPAINT_INFILL,
      is_intermediate: true,
    };
  }

  // Handle Scale Before Processing
  if (['auto', 'manual'].includes(boundingBoxScaleMethod)) {
    const scaledWidth: number = scaledBoundingBoxDimensions.width;
    const scaledHeight: number = scaledBoundingBoxDimensions.height;

    // Add Scaling Nodes
    graph.nodes[INPAINT_IMAGE_RESIZE_UP] = {
      type: 'img_resize',
      id: INPAINT_IMAGE_RESIZE_UP,
      is_intermediate: true,
      width: scaledWidth,
      height: scaledHeight,
      image: canvasInitImage,
    };
    graph.nodes[MASK_RESIZE_UP] = {
      type: 'img_resize',
      id: MASK_RESIZE_UP,
      is_intermediate: true,
      width: scaledWidth,
      height: scaledHeight,
    };
    graph.nodes[INPAINT_IMAGE_RESIZE_DOWN] = {
      type: 'img_resize',
      id: INPAINT_IMAGE_RESIZE_DOWN,
      is_intermediate: true,
      width: width,
      height: height,
    };
    graph.nodes[INPAINT_INFILL_RESIZE_DOWN] = {
      type: 'img_resize',
      id: INPAINT_INFILL_RESIZE_DOWN,
      is_intermediate: true,
      width: width,
      height: height,
    };
    graph.nodes[MASK_RESIZE_DOWN] = {
      type: 'img_resize',
      id: MASK_RESIZE_DOWN,
      is_intermediate: true,
      width: width,
      height: height,
    };

    graph.nodes[NOISE] = {
      ...(graph.nodes[NOISE] as NoiseInvocation),
      width: scaledWidth,
      height: scaledHeight,
    };

    // Connect Nodes
    graph.edges.push(
      // Scale Inpaint Image
      {
        source: {
          node_id: INPAINT_IMAGE_RESIZE_UP,
          field: 'image',
        },
        destination: {
          node_id: INPAINT_INFILL,
          field: 'image',
        },
      },
      // Take combined mask and resize and then blur
      {
        source: {
          node_id: MASK_COMBINE,
          field: 'image',
        },
        destination: {
          node_id: MASK_RESIZE_UP,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_RESIZE_UP,
          field: 'image',
        },
        destination: {
          node_id: MASK_BLUR,
          field: 'image',
        },
      },
      // Resize Results Down
      {
        source: {
          node_id: LATENTS_TO_IMAGE,
          field: 'image',
        },
        destination: {
          node_id: INPAINT_IMAGE_RESIZE_DOWN,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_BLUR,
          field: 'image',
        },
        destination: {
          node_id: MASK_RESIZE_DOWN,
          field: 'image',
        },
      },
      {
        source: {
          node_id: INPAINT_INFILL,
          field: 'image',
        },
        destination: {
          node_id: INPAINT_INFILL_RESIZE_DOWN,
          field: 'image',
        },
      },
      // Color Correct The Inpainted Result
      {
        source: {
          node_id: INPAINT_INFILL_RESIZE_DOWN,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'reference',
        },
      },
      {
        source: {
          node_id: INPAINT_IMAGE_RESIZE_DOWN,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_RESIZE_DOWN,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'mask',
        },
      },
      // Paste Everything Back
      {
        source: {
          node_id: INPAINT_INFILL_RESIZE_DOWN,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'base_image',
        },
      },
      {
        source: {
          node_id: COLOR_CORRECT,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_RESIZE_DOWN,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'mask',
        },
      }
    );
  } else {
    // Add Images To Nodes
    graph.nodes[INPAINT_INFILL] = {
      ...(graph.nodes[INPAINT_INFILL] as
        | InfillTileInvocation
        | InfillPatchMatchInvocation),
      image: canvasInitImage,
    };
    graph.nodes[NOISE] = {
      ...(graph.nodes[NOISE] as NoiseInvocation),
      width: width,
      height: height,
    };
    graph.nodes[INPAINT_IMAGE] = {
      ...(graph.nodes[INPAINT_IMAGE] as ImageToLatentsInvocation),
      image: canvasInitImage,
    };
    graph.nodes[MASK_BLUR] = {
      ...(graph.nodes[MASK_BLUR] as ImageBlurInvocation),
      image: canvasMaskImage,
    };

    graph.edges.push(
      // Take combined mask and plug it to blur
      {
        source: {
          node_id: MASK_COMBINE,
          field: 'image',
        },
        destination: {
          node_id: MASK_BLUR,
          field: 'image',
        },
      },
      // Color Correct The Inpainted Result
      {
        source: {
          node_id: INPAINT_INFILL,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'reference',
        },
      },
      {
        source: {
          node_id: LATENTS_TO_IMAGE,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_BLUR,
          field: 'image',
        },
        destination: {
          node_id: COLOR_CORRECT,
          field: 'mask',
        },
      },
      // Paste Everything Back
      {
        source: {
          node_id: INPAINT_INFILL,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'base_image',
        },
      },
      {
        source: {
          node_id: COLOR_CORRECT,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'image',
        },
      },
      {
        source: {
          node_id: MASK_BLUR,
          field: 'image',
        },
        destination: {
          node_id: CANVAS_OUTPUT,
          field: 'mask',
        },
      }
    );
  }

  // Handle seed
  if (shouldRandomizeSeed) {
    // Random int node to generate the starting seed
    const randomIntNode: RandomIntInvocation = {
      id: RANDOM_INT,
      type: 'rand_int',
    };

    graph.nodes[RANDOM_INT] = randomIntNode;

    // Connect random int to the start of the range of size so the range starts on the random first seed
    graph.edges.push({
      source: { node_id: RANDOM_INT, field: 'a' },
      destination: { node_id: RANGE_OF_SIZE, field: 'start' },
    });
  } else {
    // User specified seed, so set the start of the range of size to the seed
    (graph.nodes[RANGE_OF_SIZE] as RangeOfSizeInvocation).start = seed;
  }

  // Add Refiner if enabled
  if (shouldUseSDXLRefiner) {
    addSDXLRefinerToGraph(state, graph, SDXL_DENOISE_LATENTS);
  }

  // optionally add custom VAE
  addVAEToGraph(state, graph, SDXL_MODEL_LOADER);

  // add LoRA support
  addSDXLLoRAsToGraph(state, graph, SDXL_DENOISE_LATENTS, SDXL_MODEL_LOADER);

  // add controlnet, mutating `graph`
  addControlNetToLinearGraph(state, graph, SDXL_DENOISE_LATENTS);

  // NSFW & watermark - must be last thing added to graph
  if (state.system.shouldUseNSFWChecker) {
    // must add before watermarker!
    addNSFWCheckerToGraph(state, graph, CANVAS_OUTPUT);
  }

  if (state.system.shouldUseWatermarker) {
    // must add after nsfw checker!
    addWatermarkerToGraph(state, graph, CANVAS_OUTPUT);
  }

  return graph;
};
