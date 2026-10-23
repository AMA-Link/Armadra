import * as React from "react";

import { useT } from "@/app/preferences-store";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { Button } from "@/ui/button";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { toast } from "@/ui/toast";
import { describeFailure, toCloudError } from "../api/errors";
import { navigate, spacePath } from "../router";
import { useCreateTeam } from "./data";

/** 与协议 `teamSlugSchema` 同一条规则：小写字母与数字开头结尾，中间可有连字符，最长 40。 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** 名称 → 地址：拉丁字母和数字保留，其余折成连字符；没有可用字符（如纯中文）则留空让人填。 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** 创建团队（云端控制台 §2.2）：名称与由名称生成、可改的地址；成功后跳进 `/t/<地址>`。 */
export function CreateTeamDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const create = useCreateTeam();
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [edited, setEdited] = React.useState(false);
  const [errors, setErrors] = React.useState({ name: "", slug: "" });
  const nameRef = React.useRef<HTMLInputElement>(null);
  const slugRef = React.useRef<HTMLInputElement>(null);
  const nameId = React.useId();
  const slugId = React.useId();
  const prefix = `${window.location.host}/t/`;

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setErrors({ name: t("cloud.team.nameRequired"), slug: "" });
      nameRef.current?.focus();
      return;
    }
    if (!SLUG.test(slug)) {
      setErrors({ name: "", slug: t("cloud.team.slugInvalid") });
      slugRef.current?.focus();
      return;
    }
    try {
      const team = await create.mutateAsync({ slug, name: trimmed });
      onClose();
      navigate(spacePath({ team: team.slug }));
    } catch (failure) {
      const message = describeFailure(failure);
      if (toCloudError(failure).code === "team_slug_taken") {
        setErrors({ name: "", slug: message });
        slugRef.current?.focus();
      } else toast.error(message);
    }
  };

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t("cloud.team.create")}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field data-invalid={errors.name !== "" || undefined}>
            <FieldLabel htmlFor={nameId}>{t("cloud.team.name")}</FieldLabel>
            <Input
              id={nameId}
              ref={nameRef}
              value={name}
              maxLength={128}
              autoComplete="off"
              aria-invalid={errors.name !== "" || undefined}
              aria-describedby={errors.name ? `${nameId}-error` : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (!edited) setSlug(slugFromName(event.target.value));
                setErrors({ name: "", slug: "" });
              }}
            />
            {errors.name ? (
              <FieldError id={`${nameId}-error`}>{errors.name}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errors.slug !== "" || undefined}>
            <FieldLabel htmlFor={slugId}>{t("cloud.team.slug")}</FieldLabel>
            <InputGroup>
              <InputGroupAddon>{prefix}</InputGroupAddon>
              <InputGroupInput
                id={slugId}
                ref={slugRef}
                value={slug}
                maxLength={40}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={errors.slug !== "" || undefined}
                aria-describedby={errors.slug ? `${slugId}-error` : undefined}
                onChange={(event) => {
                  setEdited(true);
                  setSlug(event.target.value.toLowerCase());
                  setErrors({ name: "", slug: "" });
                }}
              />
            </InputGroup>
            {errors.slug ? (
              <FieldError id={`${slugId}-error`}>{errors.slug}</FieldError>
            ) : null}
          </Field>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cloud.common.cancel")}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t("cloud.team.createAction")}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
