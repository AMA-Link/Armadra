import { navigate } from "./router";

/** 改一个查询参数（不留历史），其余参数不动（云端控制台 §1.4：筛选进地址，可分享、可后退）。 */
export function setQueryParam(name: string, value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value === null || value === "") params.delete(name);
  else params.set(name, value);
  const search = params.toString();
  navigate(window.location.pathname + (search ? `?${search}` : ""), {
    replace: true,
  });
}
