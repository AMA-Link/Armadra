import * as React from "react";
import type { ContentSource } from "@armadra/shared";

/**
 * 渲染组件需要从外面拿的几样东西。组件本身不碰网络与画布：B7 接线时提供
 * `timeline.blob` 的读取与外链打开，没有提供时对应的入口自动隐藏。
 */
export interface TimelineViewServices {
  /** 经 `timeline.blob` 取图片、音频与二进制资源。 */
  loadBlob?: ((blobId: string) => Promise<Blob>) | undefined;
  /** 打开资源链接；没有就不画「打开」。 */
  openUri?: ((uri: string) => void) | undefined;
  /** 给了，diff 才有「落为变更节点」。 */
  source?: ContentSource | undefined;
}

const EMPTY: TimelineViewServices = {};

const ServicesContext = React.createContext<TimelineViewServices>(EMPTY);

export function TimelineServicesProvider({
  value,
  children,
}: {
  value: TimelineViewServices;
  children: React.ReactNode;
}) {
  return (
    <ServicesContext.Provider value={value}>
      {children}
    </ServicesContext.Provider>
  );
}

export function useTimelineServices(): TimelineViewServices {
  return React.useContext(ServicesContext);
}

/**
 * blob 的对象 URL。`enabled` 为假时不取（折叠着的音频不预取）；卸载时释放。
 */
export function useBlobUrl(
  blobId: string | undefined,
  enabled = true,
): { url: string | null; failed: boolean } {
  const { loadBlob } = useTimelineServices();
  const [state, setState] = React.useState<{
    url: string | null;
    failed: boolean;
  }>({ url: null, failed: false });
  React.useEffect(() => {
    if (!enabled || blobId === undefined || loadBlob === undefined) {
      setState({ url: null, failed: false });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    loadBlob(blobId).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      },
      () => {
        if (!cancelled) setState({ url: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [blobId, enabled, loadBlob]);
  return state;
}
