"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Modal, Input, CardSkeleton, Select, Toggle, ConfirmModal } from "@/shared/components";

/**
 * Custom model → account routing rules.
 * A rule says: for these providers+models, only (or never, or prefer) these accounts.
 * The canonical case — Codex gpt-5.6-sol only on Plus accounts, gpt-5.6-luna
 * drains free accounts first — ships as one-click presets.
 */

const EMPTY_RULE = {
  id: "",
  name: "",
  enabled: true,
  priority: 100,
  match: { providers: "", models: "", excludeModels: "" },
  select: { include: [], exclude: [] },
  order: { prefer: "", strategy: "inherit", stickyLimit: "", reverse: false },
  onEmpty: "fallthrough",
  stopOnMatch: true,
};

// ---- comma / newline → array helpers (inputs stay simple text fields) ----
const toList = (s) =>
  String(s || "")
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const toStr = (a) => (Array.isArray(a) ? a.join(", ") : a || "");

// Rule IDs are minted in event handlers, but as pure helpers so the
// react-hooks/purity lint never flags render-adjacent calls.
const newRuleId = () => `rule_${crypto.randomUUID().slice(0, 8)}`;
const newRuleDraft = () => ({ ...EMPTY_RULE, id: newRuleId() });

function conditionToText(c) {
  if (!c?.field || !c?.op) return "";
  const val = Array.isArray(c.value) ? c.value.join(",") : (c.value ?? "");
  return `${c.field} ${c.op} ${val}`.trim();
}

function parseCondition(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const field = parts[0];
  const op = parts[1];
  const rest = parts.slice(2).join(" ");
  if (!field || !op) return null;
  let value = rest;
  if (rest.includes(",")) value = rest.split(",").map((x) => x.trim()).filter(Boolean);
  else if (rest !== "" && !["exists", "empty"].includes(op) && !isNaN(Number(rest))) value = Number(rest);
  return { field, op, value };
}

export default function AccountRoutingPage() {
  const [routing, setRouting] = useState({ enabled: false, rules: [] });
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingRule, setEditingRule] = useState(null); // null | rule object
  const [confirmState, setConfirmState] = useState(null);
  const [explain, setExplain] = useState(null); // dry-run result
  const [explainProvider, setExplainProvider] = useState("");
  const [explainModel, setExplainModel] = useState("");

  const fetchRouting = useCallback(async () => {
    try {
      const res = await fetch("/api/account-routing");
      const data = await res.json();
      if (data.accountRouting) setRouting(data.accountRouting);
      if (data.meta) setMeta(data.meta);
    } catch (err) {
      console.error("Failed to load routing:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same initial-data-load pattern as the combos page
    fetchRouting();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      alert(err.message || "Failed to save routing");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = () => save({ ...routing, enabled: !routing.enabled });

  const applyPreset = async (presetId) => {
    const preset = meta?.presets?.[presetId];
    if (!preset) return;
    const rule = {
      ...EMPTY_RULE,
      ...preset.rule,
      id: newRuleId(),
      match: {
        providers: toStr(preset.rule.match?.providers),
        models: toStr(preset.rule.match?.models),
        excludeModels: "",
      },
      select: {
        include: preset.rule.select?.include || [],
        exclude: preset.rule.select?.exclude || [],
      },
      order: {
        prefer: "",
        strategy: preset.rule.order?.strategy || "inherit",
        stickyLimit: "",
        reverse: false,
      },
    };
    setEditingRule(rule);
  };

  const deleteRule = async (rule) => {
    const ok = await save({ ...routing, rules: routing.rules.filter((r) => r.id !== rule.id) });
    if (ok) setConfirmState(null);
  };

  const saveRule = async () => {
    const r = editingRule;
    if (!r.name?.trim()) return alert("Rule name is required");
    const rule = {
      ...r,
      match: {
        providers: toList(r.match.providers),
        models: toList(r.match.models),
        excludeModels: toList(r.match.excludeModels),
      },
      select: {
        include: r.select.include.filter(Boolean),
        exclude: r.select.exclude.filter(Boolean),
      },
      order: {
        prefer: toList(r.order.prefer),
        strategy: r.order.strategy || "inherit",
        stickyLimit: r.order.stickyLimit === "" ? null : Number(r.order.stickyLimit) || null,
        reverse: !!r.order.reverse,
      },
    };
    const exists = routing.rules.some((x) => x.id === rule.id);
    const rules = exists ? routing.rules.map((x) => (x.id === rule.id ? rule : x)) : [...routing.rules, rule];
    if (await save({ ...routing, rules })) setEditingRule(null);
  };

  const runExplain = async () => {
    if (!explainProvider.trim()) return alert("Provider is required");
    try {
      const res = await fetch("/api/account-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: explainProvider.trim(), model: explainModel.trim() || null }),
      });
      setExplain(await res.json());
    } catch (err) {
      alert("Dry-run failed");
    }
  };

  if (loading) return <CardSkeleton count={3} />;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            Route models to specific accounts: keep paid-tier models on paid accounts, drain free accounts first, or pin a model to chosen accounts.
          </p>
          <p className="text-sm text-text-muted mt-2">
            Plans are read from each connection (Codex: <span className="font-medium text-text-main">free / go / plus / team / pro</span>).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Toggle checked={routing.enabled} onChange={toggleEnabled} label={routing.enabled ? "Enabled" : "Disabled"} />
          <Button icon="add" onClick={() => setEditingRule(newRuleDraft())} className="whitespace-nowrap">
            Create Rule
          </Button>
        </div>
      </div>

      {/* Presets */}
      {meta?.presets && Object.keys(meta.presets).length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary">bolt</span>
            <p className="font-medium text-text-main">Quick presets</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(meta.presets).map(([id, p]) => (
              <button
                key={id}
                onClick={() => applyPreset(id)}
                className="text-sm rounded-lg border border-border-base px-3 py-2 text-left hover:border-primary hover:text-primary transition-colors"
                title={p.description}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Rules list */}
      {routing.rules.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">alt_route</span>
            </div>
            <p className="text-text-main font-medium mb-1">No routing rules yet</p>
            <p className="text-sm text-text-muted mb-4">
              Without rules every model uses all active accounts (existing behaviour). Create one or start from a preset.
            </p>
            <Button icon="add" onClick={() => setEditingRule(newRuleDraft())} className="w-full sm:w-auto">
              Create Rule
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {routing.rules.map((rule) => (
            <Card key={rule.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-text-main truncate">{rule.name || rule.id}</p>
                    <span className="text-xs rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">prio {rule.priority}</span>
                    {rule.stopOnMatch && <span className="text-xs rounded-full bg-surface-hover px-2 py-0.5 text-text-muted">stop</span>}
                  </div>
                  <div className="text-sm text-text-muted mt-1 flex flex-col gap-0.5">
                    <div>
                      <span className="font-medium">When</span> provider ∈ [{toStr(rule.match?.providers) || "any"}] · model ∈ [{toStr(rule.match?.models) || "any"}]
                      {rule.match?.excludeModels?.length > 0 && <> · except [{toStr(rule.match.excludeModels)}]</>}
                    </div>
                    <div>
                      <span className="font-medium">Use accounts</span>{" "}
                      {rule.select?.include?.length
                        ? `where ${rule.select.include.map(conditionToText).join(" AND ")}`
                        : "(all, then filter)"}
                      {rule.select?.exclude?.length > 0 && (
                        <> except {rule.select.exclude.map(conditionToText).join(" OR ")}</>
                      )}
                    </div>
                    {(rule.order?.prefer?.length > 0 || rule.order?.strategy !== "inherit") && (
                      <div>
                        <span className="font-medium">Order</span>{" "}
                        {rule.order.prefer?.length > 0 && <>prefer {rule.order.prefer.map(conditionToText).join(" OR ")} · </>}
                        {rule.order.strategy !== "inherit" && <>{rule.order.strategy}</>}
                        {rule.order?.stickyLimit ? ` · sticky ${rule.order.stickyLimit}` : ""}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    icon={rule.enabled ? "toggle_on" : "toggle_off"}
                    onClick={() => save({ ...routing, rules: routing.rules.map((x) => (x.id === rule.id ? { ...x, enabled: !x.enabled } : x)) })}
                    className={rule.enabled ? "text-primary" : "text-text-muted"}
                  />
                  <Button variant="ghost" icon="edit" onClick={() => setEditingRule({
                    ...rule,
                    match: {
                      providers: toStr(rule.match?.providers),
                      models: toStr(rule.match?.models),
                      excludeModels: toStr(rule.match?.excludeModels),
                    },
                    select: { include: rule.select?.include || [], exclude: rule.select?.exclude || [] },
                    order: {
                      prefer: toStr(rule.order?.prefer),
                      strategy: rule.order?.strategy || "inherit",
                      stickyLimit: rule.order?.stickyLimit ?? "",
                      reverse: !!rule.order?.reverse,
                    },
                  })} />
                  <Button variant="ghost" icon="delete" onClick={() => setConfirmState({ rule })} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Dry run */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-outlined text-primary">play_circle</span>
          <p className="font-medium text-text-main">Dry run</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input placeholder="provider (e.g. codex)" value={explainProvider} onChange={(e) => setExplainProvider(e.target.value)} />
          <Input placeholder="model (e.g. gpt-5.6-sol)" value={explainModel} onChange={(e) => setExplainModel(e.target.value)} />
          <Button icon="play_arrow" onClick={runExplain} className="whitespace-nowrap">Explain</Button>
        </div>
        {explain && (
          <div className="mt-4 text-sm flex flex-col gap-2">
            {explain.error ? (
              <p className="text-red-500">{explain.error}</p>
            ) : (
              <>
                <p className="text-text-muted">{explain.reason || `${explain.eligible.length} account(s) eligible`}</p>
                {explain.blocked && <p className="text-red-500 font-medium">Blocked: {explain.reason}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {explain.eligible.map((a) => (
                    <span key={a.id} className="rounded-full bg-emerald-500/10 text-emerald-600 px-2.5 py-1 text-xs">
                      {a.name} {a.plan ? `(${a.plan})` : ""}
                    </span>
                  ))}
                  {explain.filteredOut.map((a) => (
                    <span key={a.id} className="rounded-full bg-surface-hover text-text-muted line-through px-2.5 py-1 text-xs">
                      {a.name} {a.plan ? `(${a.plan})` : ""}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      {/* Create/Edit modal */}
      <Modal
        isOpen={!!editingRule}
        onClose={() => setEditingRule(null)}
        title={editingRule && routing.rules.some((x) => x.id === editingRule.id) ? "Edit Routing Rule" : "Create Routing Rule"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingRule(null)}>Cancel</Button>
            <Button onClick={saveRule} disabled={saving}>{saving ? "Saving..." : "Save Rule"}</Button>
          </>
        }
      >
        {editingRule && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Rule name" value={editingRule.name} onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })} />
              <Input label="Priority (lower = first)" type="number" value={editingRule.priority} onChange={(e) => setEditingRule({ ...editingRule, priority: Number(e.target.value) || 100 })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Providers (comma-separated, glob ok)"
                placeholder="codex, openrouter"
                value={editingRule.match.providers}
                onChange={(e) => setEditingRule({ ...editingRule, match: { ...editingRule.match, providers: e.target.value } })}
              />
              <Input
                label="Models (comma-separated, glob ok)"
                placeholder="gpt-5.6-sol, gpt-5.6-*"
                value={editingRule.match.models}
                onChange={(e) => setEditingRule({ ...editingRule, match: { ...editingRule.match, models: e.target.value } })}
              />
            </div>
            <Input
              label="Exclude models (optional)"
              placeholder="gpt-5.6-sol-review"
              value={editingRule.match.excludeModels}
              onChange={(e) => setEditingRule({ ...editingRule, match: { ...editingRule.match, excludeModels: e.target.value } })}
            />

            <ConditionList
              label="Only accounts where (AND)"
              hint="field op value(s) — e.g. plan in plus,team · id in abc,def · emailDomain eq gmail.com"
              conditions={editingRule.select.include}
              onChange={(include) => setEditingRule({ ...editingRule, select: { ...editingRule.select, include } })}
            />
            <ConditionList
              label="Never accounts where (OR)"
              hint="e.g. plan eq free"
              conditions={editingRule.select.exclude}
              onChange={(exclude) => setEditingRule({ ...editingRule, select: { ...editingRule.select, exclude } })}
            />

            <Input
              label="Prefer accounts where (comma-separated conditions)"
              hint="Moves matching accounts to the front without excluding others — e.g. plan eq free"
              placeholder="plan eq free"
              value={editingRule.order.prefer}
              onChange={(e) => setEditingRule({ ...editingRule, order: { ...editingRule.order, prefer: e.target.value } })}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select
                label="Strategy override"
                value={editingRule.order.strategy}
                onChange={(e) => setEditingRule({ ...editingRule, order: { ...editingRule.order, strategy: e.target.value } })}
                options={[{ value: "inherit", label: "Inherit provider strategy" }, ...(meta?.strategies || []).filter((s) => s.id !== "inherit").map((s) => ({ value: s.id, label: s.label }))]}
              />
              <Input
                label="Sticky limit (round robin, optional)"
                type="number"
                value={editingRule.order.stickyLimit}
                onChange={(e) => setEditingRule({ ...editingRule, order: { ...editingRule.order, stickyLimit: e.target.value } })}
              />
            </div>

            <Select
              label="When no account matches"
              value={editingRule.onEmpty}
              onChange={(e) => setEditingRule({ ...editingRule, onEmpty: e.target.value })}
              options={[
                { value: "fallthrough", label: "Ignore rule (use all accounts)" },
                { value: "error", label: "Fail the request" },
              ]}
            />

            <div className="flex items-center gap-6">
              <Toggle checked={editingRule.stopOnMatch} onChange={(v) => setEditingRule({ ...editingRule, stopOnMatch: v })} label="Stop on match (skip later rules)" />
              <Toggle checked={editingRule.order.reverse} onChange={(v) => setEditingRule({ ...editingRule, order: { ...editingRule.order, reverse: v } })} label="Reverse order" />
            </div>

            <p className="text-xs text-text-muted">
              Fields: {(meta?.fields || []).map((f) => f.id).join(", ")} — plus any <code>psd.key</code>. Operators: {(meta?.operators || []).map((o) => o.id).join(", ")}.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={() => confirmState && deleteRule(confirmState.rule)}
        title="Delete routing rule"
        message={`Delete "${confirmState?.rule?.name || confirmState?.rule?.id}"? Models it covered will fall back to all active accounts.`}
      />
    </div>
  );
}

function ConditionList({ label, hint, conditions, onChange }) {
  const [text, setText] = useState("");
  const add = () => {
    const parsed = parseCondition(text);
    if (!parsed) return alert(`Use: field op value — e.g. "plan in plus,team". Fields/ops listed below.`);
    onChange([...conditions, parsed]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-text-main">{label}</p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      {conditions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {conditions.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-1 text-xs text-text-main">
              {conditionToText(c)}
              <button onClick={() => onChange(conditions.filter((_, j) => j !== i))} className="text-text-muted hover:text-red-500">
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input placeholder="plan in plus,team" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <Button variant="secondary" icon="add" onClick={add} className="whitespace-nowrap">Add</Button>
      </div>
    </div>
  );
}
