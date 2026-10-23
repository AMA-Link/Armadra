import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/cn";
import { Indicator, IndicatorGroup } from "@/ui/indicator";

interface TabsContextValue {
  /** 当前选中的值（受控 / 非受控都镜像到这里，让触发器自己决定要不要画指示器）。 */
  value: string | undefined;
  variant: "default" | "line" | "segmented";
}

const TabsContext = React.createContext<TabsContextValue>({
  value: undefined,
  variant: "default",
});

function Tabs({
  className,
  orientation = "horizontal",
  value: valueProp,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const [inner, setInner] = React.useState(defaultValue);
  const value = valueProp ?? inner;
  const context = React.useMemo(
    () => ({ value, variant: "default" as const }),
    [value],
  );
  return (
    <IndicatorGroup>
      <TabsContext.Provider value={context}>
        <TabsPrimitive.Root
          data-slot="tabs"
          data-orientation={orientation}
          className={cn(
            "group/tabs flex gap-2 data-horizontal:flex-col",
            className,
          )}
          {...(value === undefined ? {} : { value })}
          onValueChange={(next) => {
            setInner(next);
            onValueChange?.(next);
          }}
          {...props}
        />
      </TabsContext.Provider>
    </IndicatorGroup>
  );
}

/**
 * 列表样式。`default` 灰底胶囊；`line` 下划线；`segmented`（设计系统 §9）是分段控件：
 * `--surface-raised` 底、`rounded-card`、`p-[3px]`，当前项是一块 `--card` + 1px 边的
 * 指示器，在项之间平移（`--dur-base` `--ease-in-out`）。
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
  {
    variants: {
      variant: {
        default:
          "rounded-control bg-muted p-[3px] group-data-horizontal/tabs:h-8",
        line: "gap-1 rounded-none bg-transparent p-[3px] group-data-horizontal/tabs:h-8",
        segmented: "gap-0.5 rounded-card bg-raised p-[3px]",
      },
      size: {
        default: "",
        sm: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const parent = React.useContext(TabsContext);
  const resolved = variant ?? "default";
  const context = React.useMemo(
    () => ({ value: parent.value, variant: resolved }),
    [parent.value, resolved],
  );
  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        data-size={size}
        className={cn(tabsListVariants({ variant, size }), className)}
        {...props}
      />
    </TabsContext.Provider>
  );
}

function TabsTrigger({
  className,
  value,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const { value: current, variant } = React.useContext(TabsContext);
  const active = current === value;
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      className={cn(
        "relative isolate inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-control border border-transparent px-1.5 py-0.5 text-body font-medium whitespace-nowrap text-foreground/60 transition-[color,background-color,border-color] duration-(--dur-fast) group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:text-foreground dark:data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:bg-background group-data-[variant=default]/tabs-list:dark:data-active:border-input group-data-[variant=default]/tabs-list:dark:data-active:bg-input/30",
        "group-data-[variant=segmented]/tabs-list:h-7 group-data-[variant=segmented]/tabs-list:flex-none group-data-[variant=segmented]/tabs-list:px-2.5 group-data-[variant=segmented]/tabs-list:data-active:bg-transparent group-data-[size=sm]/tabs-list:group-data-[variant=segmented]/tabs-list:h-6 group-data-[size=sm]/tabs-list:group-data-[variant=segmented]/tabs-list:px-2 group-data-[size=sm]/tabs-list:group-data-[variant=segmented]/tabs-list:text-meta",
        className,
      )}
      {...props}
    >
      {active && variant === "segmented" && (
        <Indicator className="inset-0 rounded-control border border-border bg-card" />
      )}
      {active && variant === "line" && (
        <Indicator className="inset-x-0 bottom-[-5px] z-0 h-0.5 bg-foreground group-data-vertical/tabs:inset-x-auto group-data-vertical/tabs:inset-y-0 group-data-vertical/tabs:-right-1 group-data-vertical/tabs:bottom-auto group-data-vertical/tabs:h-auto group-data-vertical/tabs:w-0.5" />
      )}
      {children}
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-body outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
