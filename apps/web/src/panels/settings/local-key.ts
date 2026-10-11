import { LOCAL_SOURCE_ID } from "../../api/source";
import { srcKey } from "../../sources/scope";

/**
 * 设置页的查询键：钉在本机源下（`["src", "local", …]`）。设置页读写的永远是
 * 这台电脑，打开别人的工作空间时同名的查询不会拿到对方的数据，也不会互相覆盖。
 */
export function lk(...rest: readonly unknown[]): readonly unknown[] {
  return srcKey(LOCAL_SOURCE_ID, ...rest);
}
