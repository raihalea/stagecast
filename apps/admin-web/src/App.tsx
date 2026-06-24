import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useLocation } from "react-router-dom";
import type { EventDefinition, EventStatus } from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AppShell,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  EventListItem,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Skeleton,
  StatusPill,
  TallyIndicator,
  ThemeToggle,
  Toaster,
  TooltipProvider,
  type ThemeMode,
} from "@stagecast/ui";
import {
  ArrowDownUp,
  Check,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Plus,
  Settings,
  Trash2,
  Users,
  X,
} from "@stagecast/ui/icons";
import { HttpControlApiClient } from "./api/http-client.js";
import { HttpAssetService } from "./api/http-asset-service.js";
import { HttpArtifactService } from "./api/http-artifact-service.js";
import type { ControlApiClient, AssetService, ArtifactService } from "./api/types.js";
import { EventForm } from "./components/EventForm.js";
import { EventDetail } from "./components/EventDetail.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { CognitoAuthClient, cognitoConfig } from "./auth/cognito.js";
import type { RuntimeConfig } from "./config.js";
import { toErrorMessage } from "./lib/errors.js";

const PAGE_SIZE = 10;

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  error?: string;
}

function readInitialTheme(): ThemeMode {
  try {
    const t = localStorage.getItem("stagecast.theme");
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {
    // localStorage unavailable
  }
  return "dark";
}

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const resolved =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  root.dataset.theme = resolved;
  try {
    localStorage.setItem("stagecast.theme", mode);
  } catch {
    // localStorage unavailable
  }
}

export function App(props: {
  config?: RuntimeConfig;
  client?: ControlApiClient;
  assets?: AssetService;
  artifacts?: ArtifactService;
}) {
  const apiBaseUrl = props.config?.controlApiUrl ?? "";
  const cognito = props.config?.cognito;
  const authClient = useMemo(
    () => (cognito ? new CognitoAuthClient(cognitoConfig(cognito)) : undefined),
    [cognito],
  );
  const getIdToken = useCallback(
    (): string | undefined =>
      authClient?.getTokens()?.idToken ?? sessionStorage.getItem("stagecast.idToken") ?? undefined,
    [authClient],
  );

  const client = useMemo(
    () => props.client ?? new HttpControlApiClient(apiBaseUrl, getIdToken),
    [props.client, apiBaseUrl, getIdToken],
  );
  const assets = useMemo(
    () => props.assets ?? new HttpAssetService(apiBaseUrl, getIdToken),
    [props.assets, apiBaseUrl, getIdToken],
  );
  const artifacts = useMemo(
    () => props.artifacts ?? new HttpArtifactService(apiBaseUrl, getIdToken),
    [props.artifacts, apiBaseUrl, getIdToken],
  );

  const navigate = useNavigate();
  const location = useLocation();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, setEvents] = useState<EventDefinition[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [apiError, setApiError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [statusFilter, setStatusFilter] = useState<EventStatus | "all">("draft");
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [page, setPage] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const totalPages = Math.max(1, Math.ceil(totalEvents / PAGE_SIZE));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setApiError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setApiError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!authClient) {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code && state) {
          await authClient.exchangeCode(code, state);
          window.history.replaceState({}, "", "/events");
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        if (authClient.getTokens()) {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        if (!cancelled) setAuth({ status: "anonymous" });
      } catch (err) {
        if (!cancelled) setAuth({ status: "anonymous", error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authClient]);

  const refresh = useCallback(async () => {
    const result = await client.listEventsPaged({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      status: statusFilter === "all" ? undefined : statusFilter,
      sort: sortNewestFirst ? "desc" : "asc",
    });
    setEvents(result.items);
    setTotalEvents(result.total);
    setEventsLoaded(true);
    if (result.items.length === 0 && page > 0) {
      setPage((p) => Math.max(0, p - 1));
    }
  }, [client, page, statusFilter, sortNewestFirst]);

  useEffect(() => {
    if (auth.status === "authenticated") void run(refresh);
  }, [auth.status, refresh, run]);

  const create = (input: CreateEventInput) =>
    run(async () => {
      const created = await client.createEvent(input);
      setPage(0);
      await refresh();
      setSheetOpen(false);
      navigate(`/events/${created.id}`);
    });

  const deleteEvent = (id: string) =>
    run(async () => {
      await client.deleteEvent(id);
      await refresh();
      navigate("/events");
    });

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectableIds = useMemo(
    () => new Set(events.filter((e) => e.status !== "live").map((e) => e.id)),
    [events],
  );

  const toggleSelectAll = () => {
    const allSelected = [...selectableIds].every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const bulkDelete = () =>
    run(async () => {
      const ids = [...selectedIds];
      for (const id of ids) {
        await client.deleteEvent(id);
      }
      await refresh();
      exitSelectMode();
      setBulkDeleteOpen(false);
      navigate("/events");
    });

  const changeFilter = (s: EventStatus | "all") => {
    setStatusFilter(s);
    setPage(0);
    exitSelectMode();
  };

  const toggleSort = () => {
    setSortNewestFirst((v) => !v);
    setPage(0);
  };

  const login = async () => {
    if (!authClient) return;
    window.location.assign(await authClient.buildLoginUrl());
  };
  const logout = () => {
    if (!authClient) return;
    authClient.clearTokens();
    window.location.assign(authClient.buildLogoutUrl());
  };

  if (auth.status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-0 p-6">
        <Card className="w-80">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TallyIndicator state="idle" />
              Stagecast
            </CardTitle>
            <CardDescription>読み込み中…</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (auth.status === "anonymous") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-0 p-6">
        <Card className="w-96">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono text-sm tracking-wider">
              <TallyIndicator state="on-air" />
              STAGECAST
            </CardTitle>
            <CardDescription>管理コンソール</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-text-secondary">
              ログインが必要です。 Cognito でサインインしてください。
            </p>
            {auth.error && (
              <p
                role="alert"
                className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
              >
                {auth.error}
              </p>
            )}
            <Button onClick={login}>Cognito でログイン</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isSettingsView = location.pathname === "/settings";
  const selectedId = location.pathname.match(/^\/events\/(.+)/)?.[1];
  const selected = events.find((e) => e.id === selectedId);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-line-1 px-4">
        <TallyIndicator state="on-air" />
        <span className="font-mono text-sm font-semibold tracking-wide text-text-primary">
          STAGECAST
        </span>
      </div>
      <div className="border-b border-line-1 px-3 py-3">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={() => setSheetOpen(true)}
          >
            <Plus className="size-4" />
            新規イベント
          </Button>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>新規イベント</SheetTitle>
              <SheetDescription>配信イベントを作成します</SheetDescription>
            </SheetHeader>
            <div className="mt-6">
              <EventForm onCreate={create} busy={busy} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col overflow-hidden py-2">
        <div className="flex items-center justify-between px-3 pb-1">
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="text-[10px] font-medium text-text-secondary hover:text-text-primary"
              >
                {[...selectableIds].every((id) => selectedIds.has(id)) ? "全解除" : "全選択"}
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="選択モードを終了"
                onClick={exitSelectMode}
              >
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                イベント
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="選択モード"
                  onClick={() => setSelectMode(true)}
                  title="複数選択"
                  disabled={!eventsLoaded || events.length === 0}
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={sortNewestFirst ? "古い順にする" : "新しい順にする"}
                  onClick={toggleSort}
                  title={sortNewestFirst ? "新しい順" : "古い順"}
                >
                  <ArrowDownUp className="size-3.5" />
                </Button>
              </div>
            </>
          )}
        </div>
        <div className="flex gap-1 px-3 pb-2">
          {(["all", "draft", "live", "ended"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeFilter(s)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                statusFilter === s
                  ? "bg-text-primary text-surface-0"
                  : "bg-surface-2 text-text-secondary hover:bg-surface-3"
              }`}
            >
              {s === "all" ? "すべて" : s === "draft" ? "下書き" : s === "live" ? "配信中" : "終了"}
            </button>
          ))}
        </div>
        {!eventsLoaded ? (
          <ul aria-busy="true" aria-label="読み込み中" className="space-y-1 px-3">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className="h-9 w-full" />
              </li>
            ))}
          </ul>
        ) : events.length === 0 ? (
          <div className="px-3">
            <EmptyState
              title={totalEvents === 0 ? "まだイベントがありません" : "該当なし"}
              description={
                totalEvents === 0
                  ? "上のボタンから作成"
                  : "フィルタ条件に一致するイベントがありません"
              }
              icon={<Users />}
            />
          </div>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                <EventListItem
                  title={e.title}
                  startsAt={e.startsAt}
                  status={e.status}
                  active={!selectMode && e.id === selectedId}
                  selectable={selectMode}
                  selected={selectedIds.has(e.id)}
                  onClick={
                    selectMode
                      ? () => e.status !== "live" && toggleSelect(e.id)
                      : () => navigate(`/events/${e.id}`)
                  }
                  disabled={selectMode && e.status === "live"}
                />
              </li>
            ))}
          </ul>
        )}
        {eventsLoaded && totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-line-1 px-3 py-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="前のページ"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="text-[10px] tabular-nums text-text-tertiary">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="次のページ"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
        {selectMode && selectedIds.size > 0 && (
          <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
            <div className="flex items-center gap-2 border-t border-line-1 px-3 py-2">
              <span className="flex-1 text-xs text-text-secondary">{selectedIds.size}件選択中</span>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={busy}
              >
                <Trash2 className="size-3.5" />
                削除
              </Button>
            </div>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{selectedIds.size}件のイベントを削除しますか？</AlertDialogTitle>
                <AlertDialogDescription>
                  選択されたイベントと関連するアセット・録画・字幕ファイルがすべて削除されます。この操作は取り消せません。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>キャンセル</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-error text-error-foreground hover:bg-error/90"
                  onClick={bulkDelete}
                >
                  {selectedIds.size}件を削除する
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-line-1 p-3">
        <Button
          variant={isSettingsView ? "secondary" : "ghost"}
          size="sm"
          onClick={() => navigate("/settings")}
          className="justify-start gap-2"
        >
          <Settings className="size-4" />
          運用設定
        </Button>
        <div className="flex items-center justify-between">
          <ThemeToggle value={theme} onChange={setTheme} />
          {authClient && (
            <Button variant="ghost" size="icon-sm" aria-label="ログアウト" onClick={logout}>
              <LogOut />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  const topBar = (
    <div className="flex h-12 items-center justify-between px-5">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>{isSettingsView ? "運用設定" : "イベント"}</span>
        {!isSettingsView && selected && (
          <>
            <span className="text-text-tertiary">/</span>
            <span className="text-text-primary">{selected.title}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {!isSettingsView && selected && (
          <StatusPill
            variant={
              selected.status === "live" ? "live" : selected.status === "ended" ? "ended" : "draft"
            }
          />
        )}
        {busy && (
          <span className="text-xs text-text-tertiary" aria-live="polite">
            処理中…
          </span>
        )}
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell sidebar={sidebar} topBar={topBar}>
        <div className="mx-auto max-w-5xl px-6 py-6">
          {apiError && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
            >
              <span className="flex-1">{apiError}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="エラーを閉じる"
                onClick={() => setApiError(undefined)}
              >
                ×
              </Button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Navigate to="/events" replace />} />
            <Route
              path="/events"
              element={
                <EmptyState
                  title="イベントを選択してください"
                  description="左のサイドバーから選ぶか、新規作成"
                  icon={<Users />}
                />
              }
            />
            <Route
              path="/events/:id"
              element={
                <EventDetailRoute
                  events={events}
                  client={client}
                  assets={assets}
                  artifacts={artifacts}
                  onChanged={() => void run(refresh)}
                  onDelete={deleteEvent}
                />
              }
            />
            <Route path="/settings" element={<SettingsPage client={client} />} />
            <Route path="*" element={<Navigate to="/events" replace />} />
          </Routes>
        </div>
      </AppShell>
      <Toaster />
    </TooltipProvider>
  );
}

function EventDetailRoute(props: {
  events: EventDefinition[];
  client: ControlApiClient;
  assets: AssetService;
  artifacts: ArtifactService;
  onChanged: () => void;
  onDelete: (id: string) => void;
}) {
  const { id } = useParams<{ id: string }>();
  const fromList = props.events.find((e) => e.id === id);
  const [fetched, setFetched] = useState<EventDefinition | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (fromList || !id) {
      setFetched(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    props.client
      .getEvent(id)
      .then((e) => {
        if (!cancelled) {
          setFetched(e);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFetched(undefined);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, fromList, props.client]);

  const event = fromList ?? fetched;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!event) {
    return (
      <EmptyState
        title="イベントが見つかりません"
        description="サイドバーから別のイベントを選んでください"
        icon={<Users />}
      />
    );
  }

  return (
    <EventDetail
      event={event}
      client={props.client}
      assets={props.assets}
      artifacts={props.artifacts}
      onChanged={props.onChanged}
      onDelete={props.onDelete}
    />
  );
}
