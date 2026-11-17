import * as React from "react";

/**
 * 节点组件是不是挂在画板引擎的宿主里。手机焦点页直接渲染节点体、不经宿主，
 * 依赖宿主的那几处（连线把手）据此自己让开。
 */
const BoardHostContext = React.createContext(false);

export const BoardHostProvider = BoardHostContext.Provider;

export function useIsBoardHost(): boolean {
  return React.useContext(BoardHostContext);
}
