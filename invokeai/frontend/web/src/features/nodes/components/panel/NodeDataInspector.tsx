import { createSelector } from '@reduxjs/toolkit';
import { stateSelector } from 'app/store/store';
import { useAppSelector } from 'app/store/storeHooks';
import { defaultSelectorOptions } from 'app/store/util/defaultMemoizeOptions';
import { IAINoContentFallback } from 'common/components/IAIImageFallback';
import ImageMetadataJSON from 'features/gallery/components/ImageMetadataViewer/ImageMetadataJSON';
import { memo } from 'react';

const selector = createSelector(
  stateSelector,
  ({ nodes }) => {
    const lastSelectedNodeId =
      nodes.selectedNodes[nodes.selectedNodes.length - 1];

    const lastSelectedNode = nodes.nodes.find(
      (node) => node.id === lastSelectedNodeId
    );

    return {
      data: lastSelectedNode?.data,
    };
  },
  defaultSelectorOptions
);

const NodeDataInspector = () => {
  const { data } = useAppSelector(selector);

  if (!data) {
    return <IAINoContentFallback label="No node selected" icon={null} />;
  }

  return <ImageMetadataJSON jsonObject={data} label="Node Data" />;
};

export default memo(NodeDataInspector);
