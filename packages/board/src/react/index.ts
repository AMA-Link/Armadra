// react 入口：对 dom 入口的薄绑定（设计 §2.8）。
export {
  BoardProvider,
  useBoard,
  useCamera,
  useEntity,
  useGestureActive,
  useSelected,
} from "./context";
export { EntityHosts, type EntityHostsProps } from "./hosts";
export {
  BoardView,
  Overlay,
  WorldOverlay,
  type BoardViewProps,
  type WorldOverlayProps,
} from "./view";
