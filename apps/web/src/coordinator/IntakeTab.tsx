import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useT } from "@/app/preferences-store";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
} from "@/ui/pagination";
import { SkeletonList } from "@/ui/skeletons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { toast } from "@/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  type IntakeCandidate,
  type Review,
  REVIEWS,
  coordinatorApi,
  coordinatorKeys,
  INTAKE_PAGE_SIZE,
} from "./api";
import { outcomeOf, pageCount } from "./model";
import { failureMessage } from "./SourcesTab";

/**
 * 分派抽屉的「候选」页（契约 §104.7）：来源仓库里没人认领的线程、协调者的判定与
 * 理由、人的复核（同意 / 不同意）和接单结果。顶部切未判定 / 已判定，底部翻页。
 * 复核只记账，不触发任何派发；只读访客看得到、改不了。
 */

export type IntakeFilter = "undecided" | "decided";

export interface IntakeViewProps {
  readonly candidates: readonly IntakeCandidate[];
  readonly total: number;
  readonly filter: IntakeFilter;
  /** 第几页，从 0 起。 */
  readonly page: number;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly offline?: boolean;
  readonly canEdit?: boolean;
  readonly onReload?: () => void;
  readonly onFilter?: (filter: IntakeFilter) => void;
  readonly onPage?: (page: number) => void;
  readonly onReview?: (id: string, review: Review | null) => void;
  /** 已派发的候选 → 画布上的成员节点；认不出节点时 `undefined`。 */
  readonly nodeOf?: (itemId: string | null) => string | undefined;
  readonly onOpenNode?: (nodeId: string) => void;
}

/** 纯展示：真抽屉与展示页共用。 */
export function IntakeView({
  candidates,
  total,
  filter,
  page,
  loading = false,
  error = false,
  offline = false,
  canEdit = true,
  onReload,
  onFilter,
  onPage,
  onReview,
  nodeOf,
  onOpenNode,
}: IntakeViewProps) {
  const t = useT();
  const count = pageCount(total);

  return (
    <div
      data-slot="intake-view"
      className="flex min-w-0 flex-col gap-(--space-block) p-(--space-page)"
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={filter}
        data-slot="intake-filter"
        aria-label={t("coordinator.tab.intake")}
        onValueChange={(next) => {
          if (next === "undecided" || next === "decided") onFilter?.(next);
        }}
      >
        <ToggleGroupItem value="undecided">
          {t("coordinator.intake.filter.undecided")}
        </ToggleGroupItem>
        <ToggleGroupItem value="decided">
          {t("coordinator.intake.filter.decided")}
        </ToggleGroupItem>
      </ToggleGroup>

      {error ? (
        <Alert variant="destructive" data-slot="intake-error">
          <AlertTitle className="text-meta">
            {t("coordinator.error")}
          </AlertTitle>
          {onReload ? (
            <AlertAction>
              <Button size="xs" variant="outline" onClick={onReload}>
                {t("coordinator.reload")}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}

      {loading ? (
        <div data-slot="intake-loading">
          <SkeletonList rows={3} size="tall" label={t("state.loading")} />
        </div>
      ) : candidates.length === 0 ? (
        error ? null : (
          <Empty className="border-0 p-6" data-slot="intake-empty">
            <EmptyHeader>
              <EmptyTitle className="text-body font-normal text-muted-foreground">
                {t("coordinator.intake.empty")}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <Table size="sm" data-slot="intake-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("coordinator.intake.kind")}</TableHead>
              <TableHead>#</TableHead>
              <TableHead>{t("coordinator.intake.title")}</TableHead>
              <TableHead>{t("coordinator.intake.author")}</TableHead>
              <TableHead>{t("coordinator.intake.authorized")}</TableHead>
              <TableHead>{t("coordinator.intake.verdict")}</TableHead>
              <TableHead>{t("coordinator.sources.mode")}</TableHead>
              <TableHead>{t("coordinator.intake.review")}</TableHead>
              <TableHead>{t("coordinator.intake.outcome")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                locked={offline || !canEdit}
                offline={offline}
                nodeId={nodeOf?.(candidate.itemId)}
                {...(onReview ? { onReview } : {})}
                {...(onOpenNode ? { onOpenNode } : {})}
              />
            ))}
          </TableBody>
        </Table>
      )}

      {count > 1 ? (
        <Pagination
          aria-label={t("coordinator.tab.intake")}
          className="mx-0 w-auto justify-end"
        >
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                text={t("coordinator.intake.previous")}
                disabled={page === 0}
                onClick={() => onPage?.(page - 1)}
              />
            </PaginationItem>
            {paginationRange(page, count).map((index, position) =>
              index === "gap" ? null : (
                <PaginationItem key={`${index}-${position}`}>
                  <PaginationLink
                    isActive={index === page}
                    aria-label={t("coordinator.intake.page", {
                      page: index + 1,
                    })}
                    onClick={() => onPage?.(index)}
                  >
                    {index + 1}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <PaginationNext
                text={t("coordinator.intake.next")}
                disabled={page >= count - 1}
                onClick={() => onPage?.(page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}

function CandidateRow({
  candidate,
  locked,
  offline,
  nodeId,
  onReview,
  onOpenNode,
}: {
  candidate: IntakeCandidate;
  locked: boolean;
  offline: boolean;
  nodeId: string | undefined;
  onReview?: (id: string, review: Review | null) => void;
  onOpenNode?: (nodeId: string) => void;
}) {
  const t = useT();
  const outcome = outcomeOf(candidate.outcome);
  const decided = candidate.verdict !== null;
  const link = /^https?:\/\//i.test(candidate.url);
  const label = `#${candidate.number}`;
  const verdict = (
    <Badge
      variant={
        candidate.verdict === "accept"
          ? "success"
          : candidate.verdict === "skip"
            ? "secondary"
            : "outline"
      }
      size="sm"
      data-slot="candidate-verdict"
      data-verdict={candidate.verdict ?? "none"}
      tabIndex={candidate.reason ? 0 : undefined}
    >
      {t(`coordinator.intake.verdict.${candidate.verdict ?? "none"}`)}
    </Badge>
  );

  return (
    <TableRow data-slot="candidate-row" data-candidate-id={candidate.id}>
      <TableCell>
        <Badge variant="secondary" size="sm">
          {t(`coordinator.sources.kind.${candidate.kind}`)}
        </Badge>
      </TableCell>
      <TableCell>
        {link ? (
          <Button asChild variant="link" size="xs" className="h-auto p-0">
            <a
              href={candidate.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("coordinator.intake.link", {
                number: candidate.number,
              })}
            >
              {label}
            </a>
          </Button>
        ) : (
          <span className="text-muted-foreground">{label}</span>
        )}
      </TableCell>
      <TableCell className="max-w-48 truncate" title={candidate.title}>
        {candidate.title}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {candidate.author ?? ""}
      </TableCell>
      <TableCell>
        <Badge
          variant={candidate.authorized ? "brand" : "outline"}
          size="sm"
          data-slot="candidate-authorized"
        >
          {t(
            candidate.authorized
              ? "coordinator.intake.authorized.yes"
              : "coordinator.intake.authorized.no",
          )}
        </Badge>
      </TableCell>
      <TableCell>
        {candidate.reason ? (
          <Tooltip>
            <TooltipTrigger asChild>{verdict}</TooltipTrigger>
            <TooltipContent>{candidate.reason}</TooltipContent>
          </Tooltip>
        ) : (
          verdict
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {candidate.modeAtVerdict
          ? t(`coordinator.sources.mode.${candidate.modeAtVerdict}`)
          : ""}
      </TableCell>
      <TableCell>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          data-slot="candidate-review"
          aria-label={t("coordinator.intake.review")}
          value={candidate.review ?? ""}
          disabled={locked || !decided}
          onValueChange={(next) =>
            onReview?.(
              candidate.id,
              (REVIEWS as readonly string[]).includes(next)
                ? (next as Review)
                : null,
            )
          }
        >
          {REVIEWS.map((review) => (
            <ToggleGroupItem key={review} value={review}>
              {t(`coordinator.intake.review.${review}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TableCell>
      <TableCell>
        {outcome?.kind === "dispatched" ? (
          nodeId !== undefined ? (
            <Button
              size="xs"
              variant="link"
              disabled={offline}
              data-slot="candidate-dispatched"
              onClick={() => onOpenNode?.(nodeId)}
            >
              {t("coordinator.intake.outcome.dispatched")}
            </Button>
          ) : (
            <Badge variant="success" size="sm" data-slot="candidate-dispatched">
              {t("coordinator.intake.outcome.dispatched")}
            </Badge>
          )
        ) : outcome?.kind === "refused" ? (
          <Badge variant="warn" size="sm" data-slot="candidate-refused">
            {outcome.code}
          </Badge>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------- 真页面 ------------------------------- */

export function IntakeTab({
  boardId,
  offline,
  canEdit,
  active,
  nodeOf,
  onOpenNode,
}: {
  boardId: string;
  offline: boolean;
  canEdit: boolean;
  active: boolean;
  nodeOf: (itemId: string | null) => string | undefined;
  onOpenNode: (nodeId: string) => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const [filter, setFilter] = React.useState<IntakeFilter>("undecided");
  const [page, setPage] = React.useState(0);
  const decided = filter === "decided";
  const intake = useQuery({
    queryKey: coordinatorKeys.intake(boardId, decided, page),
    queryFn: () =>
      coordinatorApi.intake(boardId, {
        decided,
        offset: page * INTAKE_PAGE_SIZE,
      }),
    enabled: active,
    retry: false,
  });
  const reload = () =>
    void client.invalidateQueries({
      queryKey: coordinatorKeys.intakeAll(boardId),
    });
  const review = useMutation({
    mutationFn: (input: { id: string; review: Review | null }) =>
      coordinatorApi.reviewIntake(input.id, input.review),
    onSuccess: () => {
      reload();
      // 统计在来源页。
      void client.invalidateQueries({
        queryKey: coordinatorKeys.sources(boardId),
      });
    },
    onError: (error) =>
      toast.error(failureMessage(error, t("coordinator.intake.reviewFailed"))),
  });
  const total = intake.data?.total ?? 0;
  // 最后一页被清空（过滤切换、候选被删）时回退到最后有内容的一页。
  React.useEffect(() => {
    if (intake.data && page > 0 && page >= pageCount(total)) {
      setPage(pageCount(total) - 1);
    }
  }, [intake.data, page, total]);

  return (
    <IntakeView
      candidates={intake.data?.candidates ?? []}
      total={total}
      filter={filter}
      page={page}
      loading={intake.isPending && intake.fetchStatus !== "idle"}
      error={intake.isError}
      offline={offline}
      canEdit={canEdit}
      onReload={() => void intake.refetch()}
      onFilter={(next) => {
        setFilter(next);
        setPage(0);
      }}
      onPage={setPage}
      onReview={(id, next) => review.mutate({ id, review: next })}
      nodeOf={nodeOf}
      onOpenNode={onOpenNode}
    />
  );
}
