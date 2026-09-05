"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Card, Button, Modal, CardSkeleton, ConfirmModal, Toggle } from "@/shared/components";

/**
 * Model Routes — simple model→account routing.
 *
 * Three steps, one card per route:
 *   1. pick a provider you have accounts for
 *   2. pick one model
 *   3. pick the accounts allowed to serve it
 *
 * Example: gpt-5.6-sol → your 5 Plus accounts; gpt-5.6-luna → all 20 accounts.
 * Everything else (caching, combos, fallback, modelLock cooldowns, token
 * refresh) keeps working untouched — a route only narrows which accounts may
 * serve a model.
 */

/** Searchable select — native input + filtered list, keyboard-friendly, zero deps. */
function Combobox({ value, options, onChange, placeholder, emptyHint, renderItem }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === value);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: r.width });
    setQuery("");
    setOpen(true);
  };

  // Outside-click + scroll-away close
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    // Capture-phase scroll close — but never for scrolls INSIDE the menu
    // itself (its option list scrolls). e.target is the scrolling element.
    const onScroll = (e) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-text-main hover:border-primary/50 transition-colors"
      >
        <span className={selected ? "" : "text-text-muted"}>{selected ? selected.label : (placeholder || "Select...")}</span>
        <span className="material-symbols-outlined text-text-muted text-[18px]">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open && rect && createPortal(
        <div
          ref={listRef}
          style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 rounded-lg border border-border-base bg-surface shadow-lg"
        >
          <div className="p-2 border-b border-border-base">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search..."
              className="w-full px-2 py-1.5 bg-surface-hover border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 && <p className="text-xs text-text-muted px-2 py-3 text-center">{emptyHint || "No matches"}</p>}
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); setQuery(""); }}
                className={`w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${o.value === value ? "bg-primary/10 text-primary" : "text-text-main hover:bg-surface-hover"}`}
              >
                {renderItem ? renderItem(o) : o.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function routeToDraft(route, providers) {
  const provider = providers.find((p) => p.id === route.match?.providers?.[0]) || null;
  const model = route.match?.models?.[0] || "";
  const cond = route.select?.include?.find((c) => c.field === "id" && c.op === "in");
  const accountIds = Array.isArray(cond?.value) ? cond.value : cond?.value ? [cond.value] : [];
  return { provider, model, accountIds, alias: route.alias || "" };
}

/** Only rules the wizard created (single id-in pin) are editable without loss. */
function isWizardRule(route) {
  const include = route.select?.include || [];
  const pin = include.find((c) => c.field === "id" && c.op === "in");
  return (
    Array.isArray(route.match?.providers) && route.match.providers.length === 1 &&
    Array.isArray(route.match?.models) && route.match.models.length === 1 &&
    !!pin && include.length === 1 && !(route.select?.exclude?.length > 0)
  );
}

function draftToRule(draft, existing) {
  const accountIds = draft.accountIds;
  return {
    ...(existing || {}),
    id: existing?.id || `route_${crypto.randomUUID().slice(0, 8)}`,
    name: draft.model,
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 100,
    match: {
      providers: [draft.provider.id],
      models: [draft.model],
      excludeModels: [],
    },
    // Only the picked accounts may serve this model.
    select: {
      include: [{ field: "id", op: "in", value: accountIds }],
      exclude: [],
    },
    order: { prefer: [], strategy: "inherit", stickyLimit: null, reverse: false },
    onEmpty: existing?.onEmpty || "error",
    stopOnMatch: true,
    alias: (draft.alias || "").trim(),
  };
}

export default function AccountRoutingPage() {
  const [routing, setRouting] = useState({ enabled: false, rules: [] });
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(null); // {provider, model, accountIds} | null
  const [editingRule, setEditingRule] = useState(null); // rule being edited (draft = its content)
  const [confirmState, setConfirmState] = useState(null);

  const fetchRouting = async () => {
    try {
      const res = await fetch("/api/account-routing", { cache: "no-store" });
      const data = await res.json();
      if (data.accountRouting) setRouting(data.accountRouting);
      if (data.providers) setProviders(data.providers);
    } catch (err) {
      console.error("Failed to load routes:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same initial-data-load pattern as the combos page
    fetchRouting();
  }, []);

  const save = async (next) => {
    setSaving(true);
    try {
      const res = await fetch("/api/account-routing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountRouting: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setRouting(data.accountRouting);
      return true;
    } catch (err) {
      alert(err.message || "Failed to save");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft?.provider || !draft.model?.trim()) return alert("Pick a provider and a model");
    if (draft.accountIds.length === 0) return alert("Pick at least one account");
    const rule = draftToRule(draft, editingRule);
    const exists = routing.rules.some((r) => r.id === rule.id);
    const rules = exists
      ? routing.rules.map((r) => (r.id === rule.id ? rule : r))
      : [...routing.rules, rule];
    if (await save({ ...routing, rules })) {
      setDraft(null);
      setEditingRule(null);
    }
  };

  const deleteRule = async (rule) => {
    if (await save({ ...routing, rules: routing.rules.filter((r) => r.id !== rule.id) })) {
      setConfirmState(null);
    }
  };

  const toggleRoute = (rule) =>
    save({ ...routing, rules: routing.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) });

  const accountsById = new Map(providers.flatMap((p) => p.accounts.map((a) => [a.id, { ...a, provider: p.id }])));
  const renderRuleAccounts = (rule) => {
    const cond = rule.select?.include?.find((c) => c.field === "id" && c.op === "in");
    const ids = Array.isArray(cond?.value) ? cond.value : cond?.value ? [cond.value] : [];
    return ids.map((id) => accountsById.get(id)).filter(Boolean);
  };

  if (loading) return <CardSkeleton count={3} />;

  const draftProvider = draft?.provider;
  const draftAccounts = draftProvider?.accounts || [];

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            Pick a provider, pick a model, pick the accounts allowed to serve it. Everything else (fallback, cooldowns, refresh) keeps working as is.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Toggle
            checked={routing.enabled}
            onChange={() => save({ ...routing, enabled: !routing.enabled })}
            label={routing.enabled ? "Enabled" : "Disabled"}
          />
          <Button icon="add" onClick={() => { setEditingRule(null); setDraft({ provider: null, model: "", accountIds: [] }); }} className="whitespace-nowrap">
            Create Model Route
          </Button>
        </div>
      </div>

      {/* Routes list */}
      {routing.rules.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">alt_route</span>
            </div>
            <p className="text-text-main font-medium mb-1">No model routes yet</p>
            <p className="text-sm text-text-muted mb-4">
              Without a route, every model uses all active accounts of its provider. Example: route gpt-5.6-sol to your Plus accounts only.
            </p>
            <Button icon="add" onClick={() => { setEditingRule(null); setDraft({ provider: null, model: "", accountIds: [] }); }} className="w-full sm:w-auto">
              Create Model Route
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {routing.rules.map((rule) => {
            const providerId = rule.match?.providers?.[0];
            const model = rule.match?.models?.[0] || "(any)";
            const accounts = renderRuleAccounts(rule);
            const provider = providers.find((p) => p.id === providerId);
            const providerName = provider?.name || providerId || "?";
            return (
              <Card key={rule.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-text-main truncate">{model}</p>
                      <span className="text-xs rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">{providerName}</span>
                      <span className="text-xs rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">
                        {isWizardRule(rule) ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : "advanced rule"}
                      </span>
                      {!rule.enabled && <span className="text-xs rounded-full bg-amber-500/10 text-amber-600 px-2 py-0.5">off</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {accounts.map((a) => (
                        <span key={a.id} className="rounded-full bg-surface-hover px-2.5 py-1 text-xs text-text-main">
                          {a.name} {a.plan ? <span className="text-text-muted">({a.plan})</span> : null}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      icon={rule.enabled ? "toggle_on" : "toggle_off"}
                      onClick={() => toggleRoute(rule)}
                      className={rule.enabled ? "text-primary" : "text-text-muted"}
                    />
                    {isWizardRule(rule) ? (
                      <Button
                        variant="ghost"
                        icon="edit"
                        onClick={() => {
                          setEditingRule(rule);
                          setDraft(routeToDraft(rule, providers));
                        }}
                      />
                    ) : (
                      <span
                        className="text-xs text-text-muted px-1"
                        title="Rule was created with advanced syntax (API) — edit via DELETE + recreate"
                      >
                        (api)
                      </span>
                    )}
                    <Button variant="ghost" icon="delete" onClick={() => setConfirmState({ rule })} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit wizard */}
      <Modal
        isOpen={!!draft}
        onClose={() => { setDraft(null); setEditingRule(null); }}
        title={editingRule ? "Edit Model Route" : "Create Model Route"}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setDraft(null); setEditingRule(null); }}>Cancel</Button>
            <Button onClick={saveDraft} disabled={saving}>{saving ? "Saving..." : "Save Route"}</Button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col gap-5">
            {/* Step 1 — provider */}
            <div>
              <p className="text-sm font-medium text-text-main mb-2">1. Provider</p>
              <Combobox
                value={draftProvider?.id || ""}
                onChange={(id) => {
                  const p = providers.find((x) => x.id === id) || null;
                  setDraft({ ...draft, provider: p, model: "", accountIds: [], alias: editingRule?.alias || "" });
                }}
                options={providers.map((p) => ({ value: p.id, label: `${p.name} (${p.connectionCount} accounts)` }))}
                placeholder="Select provider..."
              />
            </div>

            {/* Step 2 — model */}
            {draftProvider && (
              <div>
                <p className="text-sm font-medium text-text-main mb-2">2. Model</p>
                <Combobox
                  value={draft.model}
                  onChange={(m) => setDraft({ ...draft, model: m })}
                  options={draftProvider.models.map((m) => ({ value: m, label: m }))}
                  placeholder="Select model..."
                  emptyHint="No models listed for this provider"
                />
                {draftProvider.models.length === 0 && (
                  <p className="text-xs text-text-muted mt-1.5">No models listed for this provider — connect an account or add models first.</p>
                )}
              </div>
            )}

            {/* Optional: callable alias — exposes this route as its own model id */}
            {draftProvider && draft.model && (
              <div>
                <p className="text-sm font-medium text-text-main mb-2">
                  Route name <span className="text-text-muted font-normal">(optional — call this model by id from any client)</span>
                </p>
                <input
                  type="text"
                  value={draft.alias}
                  onChange={(e) => setDraft({ ...draft, alias: e.target.value })}
                  placeholder="e.g. sol-plus, team-fast"
                  className="w-full rounded-lg border border-border-base bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Unique. Clients can request <span className="text-text-main">{draft.alias?.trim() || "<name>"}</span> directly — it routes to {draft.model} on the accounts below. Leave empty to keep the route internal.
                </p>
              </div>
            )}

            {/* Step 3 — accounts */}
            {draftProvider && draft.model && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-text-main">3. Accounts allowed to serve this model</p>
                  <div className="flex gap-2">
                    <button className="text-xs text-primary hover:underline" onClick={() => setDraft({ ...draft, accountIds: draftAccounts.map((a) => a.id) })}>All</button>
                    <button className="text-xs text-primary hover:underline" onClick={() => setDraft({ ...draft, accountIds: draftAccounts.filter((a) => a.plan === "free").map((a) => a.id) })}>Free</button>
                    <button className="text-xs text-primary hover:underline" onClick={() => setDraft({ ...draft, accountIds: draftAccounts.filter((a) => a.plan && a.plan !== "free").map((a) => a.id) })}>Paid</button>
                    <button className="text-xs text-text-muted hover:underline" onClick={() => setDraft({ ...draft, accountIds: [] })}>None</button>
                  </div>
                </div>
                {draftAccounts.length === 0 ? (
                  <p className="text-xs text-text-muted">No active accounts for this provider.</p>
                ) : (
                  <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
                    {draftAccounts.map((a) => {
                      const checked = draft.accountIds.includes(a.id);
                      return (
                        <label key={a.id} className="flex items-center gap-3 rounded-lg border border-border-base px-3 py-2 cursor-pointer hover:border-primary/40 transition-colors">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                accountIds: e.target.checked
                                  ? [...draft.accountIds, a.id]
                                  : draft.accountIds.filter((id) => id !== a.id),
                              })
                            }
                            className="accent-primary"
                          />
                          <span className="text-sm text-text-main truncate flex-1">{a.name}</span>
                          {a.plan && <span className="text-xs rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">{a.plan}</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-text-muted mt-2">
                  {draft.accountIds.length} of {draftAccounts.length} selected. Requests for this model fail only if every selected account is cooling down — other accounts are never used.
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={() => confirmState && deleteRule(confirmState.rule)}
        title="Delete model route"
        message={`Stop restricting "${confirmState?.rule?.match?.models?.[0] || "model"}"? It will go back to using all active accounts.`}
      />
    </div>
  );
}
