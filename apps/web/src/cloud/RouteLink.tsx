import type { ComponentProps, MouseEvent } from "react";

import { navigate } from "./router";

/**
 * 站内链接：真 `<a href>`（新标签、复制地址都照常），普通左键点击走 History
 * 不整页重载。可套进 `Button asChild`。
 */
export function RouteLink({
  href,
  onClick,
  children,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.target === "_blank"
    )
      return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={handle} {...props}>
      {children}
    </a>
  );
}
