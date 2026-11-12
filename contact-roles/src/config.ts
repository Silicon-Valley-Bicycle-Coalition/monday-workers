import { createConfigSelector } from './environment';
import production from '../config/svbc.json';
import sandbox from '../config/sandbox.json';

// Validates a config/*.json at startup so a typo or half-filled rule fails the first run, not a
// silent no-op. Board ids and column titles live in config; column titles are the BARE titles
// (no 🔒/📜 marker), matched with `bareTitle`.

export interface BoardRule {
  name: string; // for logs only
  boardId: string;
  orgColumn: string; // bare title of the organization link
  contactsColumn: string; // bare title
  role?: string; // fixed role label; absent when typeColumn is used
  typeColumn?: string; // bare title of the Type column
  typeRoles?: Record<string, string>; // Type label -> role label
  enabled: boolean;
}

export interface ContactRolesConfig {
  monday: { apiUrl: string };
  affiliations: { boardId: string; rolesColumn: string; statusColumn: string; personColumn: string; orgColumn: string; currentLabel: string };
  boards: BoardRule[];
}

type Json = Record<string, unknown>;

function obj(raw: unknown, path: string): Json {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`config: ${path} must be an object`);
  return raw as Json;
}

function str(o: Json, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`config: ${path}.${key} must be a non-empty string`);
  return v;
}

function boardRule(raw: unknown, path: string): BoardRule {
  const o = obj(raw, path);
  const enabled = o.enabled;
  if (typeof enabled !== 'boolean') throw new Error(`config: ${path}.enabled must be a boolean`);
  const rule: BoardRule = {
    name: str(o, 'name', path), boardId: str(o, 'boardId', path),
    orgColumn: str(o, 'orgColumn', path), contactsColumn: str(o, 'contactsColumn', path), enabled,
  };
  const hasRole = o.role !== undefined;
  const hasType = o.typeColumn !== undefined || o.typeRoles !== undefined;
  if (hasRole && hasType) throw new Error(`config: ${path} sets both role and typeColumn/typeRoles; use one`);
  if (!hasRole && !hasType) throw new Error(`config: ${path} needs a role, or typeColumn with typeRoles`);
  if (hasRole) {
    rule.role = str(o, 'role', path);
  } else {
    rule.typeColumn = str(o, 'typeColumn', path);
    const roles = obj(o.typeRoles, `${path}.typeRoles`);
    const entries = Object.entries(roles);
    if (entries.length === 0) throw new Error(`config: ${path}.typeRoles must map at least one Type label`);
    rule.typeRoles = {};
    for (const [label] of entries) rule.typeRoles[label] = str(roles, label, `${path}.typeRoles`);
  }
  return rule;
}

export function validateConfig(raw: unknown): ContactRolesConfig {
  const o = obj(raw, 'config');
  const monday = obj(o.monday, 'monday');
  const aff = obj(o.affiliations, 'affiliations');
  if (!Array.isArray(o.boards)) throw new Error('config: boards must be an array');
  const boards = o.boards.map((b, i) => boardRule(b, `boards[${i}]`));
  const seen = new Set<string>();
  for (const b of boards) {
    if (seen.has(b.boardId)) throw new Error(`config: duplicate boardId ${b.boardId} in boards`);
    seen.add(b.boardId);
  }
  return {
    monday: { apiUrl: str(monday, 'apiUrl', 'monday') },
    affiliations: {
      boardId: str(aff, 'boardId', 'affiliations'), rolesColumn: str(aff, 'rolesColumn', 'affiliations'),
      statusColumn: str(aff, 'statusColumn', 'affiliations'), personColumn: str(aff, 'personColumn', 'affiliations'),
      orgColumn: str(aff, 'orgColumn', 'affiliations'), currentLabel: str(aff, 'currentLabel', 'affiliations'),
    },
    boards,
  };
}

export const configFor = createConfigSelector({ production, sandbox, validate: validateConfig });
