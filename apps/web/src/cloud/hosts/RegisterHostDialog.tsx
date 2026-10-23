import * as React from "react";
import { Copy } from "lucide-react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Spinner } from "@/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { useCloudApi } from "../api/context";
import { RouteLink } from "../RouteLink";
import { spaceBase, type CloudSpace } from "../space";
import { useRegistrationToken } from "./grants-data";

/**
 * 在服务器上登记的命令（`armadra-server cloud register`）：令牌不进命令行也不进 shell 历史——
 * `read -rs` 静默读入（把上面的令牌粘贴进去），再经标准输入交给 `--token-stdin`；issuer 加单引号。
 */
function registerCommand(issuer: string): string {
  const quoted = `'${issuer.replaceAll("'", "'\\''")}'`;
  return `read -rs T && printf %s "$T" | armadra-server cloud register --issuer ${quoted} --token-stdin`;
}

/** 桌面壳认的深链只带 `issuer`（干净的来源）；认不出就不带参数。 */
function appLink(issuer: string): string {
  try {
    const url = new URL(issuer);
    return `armadra://cloud?issuer=${encodeURIComponent(url.origin)}`;
  } catch {
    return "armadra://cloud";
  }
}

const MINUTE = 60_000;

/** 失败旁边的动作：邮箱未验证 → 重新发送验证邮件；主机数到上限 → 去用量与计划。 */
function FailureActions({ space, code }: { space: CloudSpace; code: string }) {
  const t = useT();
  const api = useCloudApi();
  const [sent, setSent] = React.useState(false);
  if (code === "email_unverified")
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={sent}
        onClick={() => {
          setSent(true);
          api.client.auth.emailVerifyResend({}).catch((failure: unknown) => {
            setSent(false);
            toast.error(describeFailure(failure));
          });
        }}
      >
        {t(sent ? "cloud.unverified.sent" : "cloud.unverified.resend")}
      </Button>
    );
  if (code === "limit_reached" && space.kind === "team")
    return (
      <Button asChild size="sm" variant="outline">
        <RouteLink href={`${spaceBase(space)}/billing`}>
          {t("cloud.nav.billing")}
        </RouteLink>
      </Button>
    );
  return null;
}

/**
 * 登记主机（云端控制台 §3.3.4）：打开时取一枚注册令牌（10 分钟有效）。「在 Armadra 里登记」是
 * 回到桌面端的深链；「服务器」页签给令牌与一条可复制的命令，下面一行提醒能进终端的成员的权限。
 * 取令牌失败（团队不让成员登记、角色不够、邮箱未验证、主机数到上限）按 `code` 出文案，不画页签。
 */
export function RegisterHostDialog({
  space,
  onClose,
}: {
  space: CloudSpace;
  onClose: () => void;
}) {
  const t = useT();
  const { mutate, data, error, isPending, reset } = useRegistrationToken(space);
  const [now, setNow] = React.useState(() => Date.now());
  const started = React.useRef(false);
  const id = React.useId();

  React.useEffect(() => {
    // 严格模式下 effect 会跑两次：只取一枚。
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  React.useEffect(() => {
    if (!data) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [data]);

  // `now` 每 15 秒推一次让倒计时重算；取令牌之后才有的时间用 Date.now() 兜底，免得初始值比令牌早。
  const current = Math.max(now, Date.now());
  const expired = data !== undefined && data.expiresAtMs <= current;
  const minutes = data
    ? Math.max(1, Math.ceil((data.expiresAtMs - current) / MINUTE))
    : 0;
  const command = data ? registerCommand(data.issuer) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("cloud.hosts.copied"));
    } catch {
      toast.error(t("error.internal"));
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.hosts.register")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {isPending || (!data && !error) ? (
          <div className="flex justify-center py-6">
            <Spinner aria-label={t("cloud.hosts.registerToken")} />
          </div>
        ) : error ? (
          <Alert
            variant="destructive"
            className="flex flex-wrap items-center gap-2"
          >
            <AlertTitle className="min-w-0 flex-1">
              {describeFailure(error)}
            </AlertTitle>
            <FailureActions space={space} code={toCloudError(error).code} />
          </Alert>
        ) : data ? (
          <Tabs defaultValue="app">
            <TabsList variant="line" className="mb-3">
              <TabsTrigger value="app">
                {t("cloud.hosts.registerFromApp")}
              </TabsTrigger>
              <TabsTrigger value="server">
                {t("cloud.hosts.registerServer")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="app">
              <Button asChild>
                <a href={appLink(data.issuer)}>
                  {t("cloud.hosts.registerFromApp")}
                </a>
              </Button>
            </TabsContent>
            <TabsContent value="server" className="flex flex-col gap-3">
              <Field>
                <FieldLabel htmlFor={id}>
                  {t("cloud.hosts.registerToken")}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={id}
                    readOnly
                    value={data.registrationToken}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <InputGroupAddon align="inline-end">
                    {expired ? (
                      <>
                        <span className="text-caption text-muted-foreground">
                          {t("cloud.hosts.registerExpired")}
                        </span>
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            reset();
                            mutate();
                          }}
                        >
                          {t("cloud.hosts.registerRefresh")}
                        </Button>
                      </>
                    ) : (
                      <span className="text-caption text-muted-foreground tabular-nums">
                        {t("cloud.hosts.registerExpires", { minutes })}
                      </span>
                    )}
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Button
                variant="outline"
                className="self-start"
                disabled={expired}
                onClick={() => void copy()}
              >
                <Copy aria-hidden data-icon="inline-start" />
                {t("cloud.hosts.copyCommand")}
              </Button>
              <Alert>
                <AlertTitle>{t("cloud.hosts.sharedMachine")}</AlertTitle>
              </Alert>
            </TabsContent>
          </Tabs>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
