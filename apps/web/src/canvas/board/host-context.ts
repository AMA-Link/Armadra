import * as React from "react";

/**
 * 节点组件是不是挂在自研引擎的宿主里。React Flow 的节点上下文在宿主里不存在，
 * 依赖它的那几处（连线把手）据此自己让开；B6 删掉 React Flow 后这个标记一并删。
 */
const BoardHostContext = React.createContext(false);

export const BoardHostProvider = BoardHostContext.Provider;

export function useIsBoardHost(): boolean {
  return React.useContext(BoardHostContext);
}
