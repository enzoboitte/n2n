"use client";

import { useEnvVars } from "@/contexts/EnvContext";
import { useMcpServersList } from "@/contexts/McpContext";
import { useProjectsList } from "@/contexts/ProjectsContext";
import type { ParamSpec } from "@/lib/types";

type Props = {
  spec: ParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  compact?: boolean;
  /** Sibling params on the same node — needed by widgets that adapt to
   *  another param's value (e.g. mcp-arguments reads the selected target). */
  allParams?: Record<string, unknown>;
  /** Letters available on this node (one per incoming edge, in order).
   *  Drives the "letter" param type dropdown (e.g. picker). */
  availableLetters?: string[];
};

export function ParamField({
  spec,
  value,
  onChange,
  compact = false,
  allParams,
  availableLetters,
}: Props) {
  const inputClass = `w-full rounded border border-slate-200 bg-white px-2 ${
    compact ? "py-1 text-xs" : "py-1.5 text-sm"
  } outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900`;

  switch (spec.type) {
    case "boolean":
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded accent-indigo-600"
          />
          <span className="text-slate-600 dark:text-slate-300">
            {String(!!value)}
          </span>
        </label>
      );

    case "select":
      return (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {spec.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );

    case "text":
      return (
        <textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={compact ? 2 : 5}
          className={`${inputClass} resize-y font-mono`}
        />
      );

    case "kv":
      return <KvEditor value={normalizeKv(value)} onChange={onChange} />;

    case "env-key":
      return (
        <EnvKeyField
          value={value}
          onChange={onChange}
          inputClass={inputClass}
        />
      );

    case "project-id":
      return (
        <ProjectIdField
          value={value}
          onChange={onChange}
          inputClass={inputClass}
        />
      );

    case "letter":
      return (
        <LetterField
          value={value}
          onChange={onChange}
          inputClass={inputClass}
          available={availableLetters ?? []}
        />
      );

    case "mcp-target":
      return (
        <McpTargetField
          value={value}
          onChange={onChange}
          inputClass={inputClass}
        />
      );

    case "mcp-arguments":
      return (
        <McpArgumentsField
          value={value}
          onChange={onChange}
          target={String(allParams?.target ?? "")}
        />
      );

    case "string":
    default:
      return (
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      );
  }
}

function normalizeKv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[String(k)] = String(v ?? "");
  }
  return out;
}

function KvEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);

  const update = (index: number, key: string, val: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) next[key] = val;
      else next[k] = v;
    });
    onChange(next);
  };

  const remove = (index: number) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i !== index) next[k] = v;
    });
    onChange(next);
  };

  const add = () => {
    let key = "key";
    let i = 1;
    while (key in value) key = `key${++i}`;
    onChange({ ...value, [key]: "" });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {entries.length === 0 && (
        <p className="text-xs text-slate-400 dark:text-slate-500">
          Aucune entrée.
        </p>
      )}
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={k}
            placeholder="clé"
            onChange={(e) => update(i, e.target.value, v)}
            className="w-1/3 rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
          />
          <input
            type="text"
            value={v}
            placeholder="valeur"
            onChange={(e) => update(i, k, e.target.value)}
            className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            onClick={() => remove(i)}
            title="Retirer"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500 hover:border-indigo-400 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-400"
      >
        + Ajouter
      </button>
    </div>
  );
}

function McpTargetField({
  value,
  onChange,
  inputClass,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  inputClass: string;
}) {
  const servers = useMcpServersList();
  const current = String(value ?? "");
  const totalTools = servers.reduce((sum, s) => sum + s.tools.length, 0);
  return (
    <>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        <option value="">— sélectionner un outil MCP —</option>
        {servers.map((s) => (
          <optgroup
            key={s.name}
            label={`${s.name}${s.connected ? "" : " (déconnecté)"} · ${s.tools.length} outil${s.tools.length > 1 ? "s" : ""}`}
          >
            {s.tools.map((t) => (
              <option
                key={`${s.name}::${t.name}`}
                value={`${s.name}::${t.name}`}
                title={t.description}
              >
                {t.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {totalTools === 0 && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Aucun serveur MCP connecté. Cliquez sur « MCP » dans la palette pour
          en ajouter un.
        </span>
      )}
    </>
  );
}

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

function asObjectArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return {};
}

function McpArgumentsField({
  value,
  onChange,
  target,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  target: string;
}) {
  const servers = useMcpServersList();
  const sep = target.indexOf("::");
  const serverName = sep >= 0 ? target.slice(0, sep) : "";
  const toolName = sep >= 0 ? target.slice(sep + 2) : "";
  const server = servers.find((s) => s.name === serverName);
  const tool = server?.tools.find((t) => t.name === toolName);
  const schema = (tool?.inputSchema ?? {}) as JsonSchema;

  const current = asObjectArgs(value);

  const update = (key: string, val: unknown) => {
    const next = { ...current };
    if (val === undefined || val === "" || val === null) {
      delete next[key];
    } else {
      next[key] = val;
    }
    onChange(next);
  };

  if (!tool) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Sélectionnez d&apos;abord un outil MCP dans le champ « Outil MCP »
        pour voir le formulaire correspondant.
      </div>
    );
  }

  const properties = schema.properties || {};
  const required = new Set(schema.required ?? []);
  const propEntries = Object.entries(properties);

  if (propEntries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Cet outil ne prend aucun argument.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50/50 p-2 dark:border-slate-700 dark:bg-slate-800/30">
      <div className="text-[10px] text-slate-500 dark:text-slate-400">
        Chaque champ accepte du texte fixe OU des variables (
        <code className="font-mono">{"{a}"}</code>,{" "}
        <code className="font-mono">{"{NOM_VAR}"}</code>,{" "}
        <code className="font-mono">{"{a.path.b}"}</code>).
      </div>
      {propEntries.map(([name, prop]) => (
        <McpArgRow
          key={name}
          name={name}
          schema={prop}
          required={required.has(name)}
          value={current[name]}
          onChange={(v) => update(name, v)}
        />
      ))}
    </div>
  );
}

function McpArgRow({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const type = schema.type || "string";
  const placeholder =
    schema.description ||
    (type === "number" || type === "integer"
      ? "42 ou {a}"
      : type === "boolean"
        ? "true / false ou {a}"
        : type === "array"
          ? '["x", "y"] ou {a}'
          : type === "object"
            ? '{"k": "v"} ou {a}'
            : `{a} ou texte`);

  const labelEl = (
    <label className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-300">
      <span className="font-mono">{name}</span>
      <span className="text-slate-400">({type})</span>
      {required && <span className="text-rose-500">*</span>}
    </label>
  );

  const stringValue =
    value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return (
    <div className="flex flex-col gap-0.5">
      {labelEl}
      {schema.description && (
        <span className="text-[10px] italic text-slate-500 dark:text-slate-400">
          {schema.description}
        </span>
      )}
      {schema.enum && schema.enum.length > 0 ? (
        <select
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">— défaut —</option>
          {schema.enum.map((opt) => {
            const v = String(opt);
            return (
              <option key={v} value={v}>
                {v}
              </option>
            );
          })}
        </select>
      ) : type === "array" || type === "object" ? (
        <textarea
          value={stringValue}
          placeholder={placeholder}
          rows={2}
          onChange={(e) => onChange(e.target.value)}
          className="resize-y rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      ) : (
        <input
          type="text"
          value={stringValue}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900"
        />
      )}
    </div>
  );
}

function LetterField({
  value,
  onChange,
  inputClass,
  available,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  inputClass: string;
  available: string[];
}) {
  const current = String(value ?? "");
  return (
    <>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} font-mono`}
      >
        {available.length === 0 && <option value="">— aucune arête —</option>}
        {available.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      {available.length === 0 && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Connectez d&apos;abord une arête en entrée pour voir les lettres.
        </span>
      )}
    </>
  );
}

function ProjectIdField({
  value,
  onChange,
  inputClass,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  inputClass: string;
}) {
  const { projects, activeId } = useProjectsList();
  const current = String(value ?? "");
  const others = projects.filter((p) => p.id !== activeId);
  const known = current && projects.some((p) => p.id === current);
  return (
    <>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        <option value="">— sélectionner un projet —</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {current && !known && (
        <span className="text-[10px] text-rose-500">
          Projet introuvable ({current.slice(0, 8)}…)
        </span>
      )}
      {others.length === 0 && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Aucun autre projet. Créez-en un via le menu projet en haut.
        </span>
      )}
    </>
  );
}

function EnvKeyField({
  value,
  onChange,
  inputClass,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  inputClass: string;
}) {
  const env = useEnvVars();
  const keys = Object.keys(env);
  const listId = "n2n-env-keys";
  return (
    <>
      <input
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="NOM_VARIABLE"
        className={`${inputClass} font-mono`}
      />
      <datalist id={listId}>
        {keys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {keys.length === 0 && (
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          Aucune variable définie. Cliquez sur {"{ENV}"} en haut à gauche pour
          en créer.
        </span>
      )}
    </>
  );
}
