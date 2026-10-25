// Shapes of registry/dist/index.json. Written by scripts/build-registry.ts, read by the site.
// Every string here that came from a widget repo has been sanitised to plain text at build time.

import type { Layout, SampleData } from './layout';

export type Category =
  | 'system'
  | 'time-calendar'
  | 'productivity'
  | 'dev-git'
  | 'ai-agents'
  | 'media'
  | 'communication'
  | 'network-containers'
  | 'ambient-fun'
  | 'utilities';

export type Status = 'planned' | 'alpha' | 'stable';

/** Describes how much review a widget got, never how isolated it is. */
export type Tier = 'concept' | 'spec' | 'community' | 'verified' | 'core';

export interface SizeClass {
  name: string;
  min: [number, number];
  max: [number, number];
  aspectLock?: number | null;
}

export interface Provider {
  name: string;
  topics: string[];
  fields: string[];
  auth?: 'none' | 'vault';
}

export interface Capabilities {
  network: string[];
  files: string[];
  spawn: string[];
}

export interface Setting {
  key: string;
  type: 'int' | 'number' | 'bool' | 'string' | 'enum';
  label?: string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: string[];
}

/** Plain-language access summary. Each list says "none" explicitly when empty. */
export interface Access {
  data: string[];
  network: string[];
  files: string[];
  programs: string[];
  secrets: string[];
}

export interface ReviewInfo {
  tier: 'core' | 'verified' | 'spec';
  reviewer: string;
  date: string;
  reviewedCommit: string;
}

export interface RegistryWidget {
  id: string;
  /** Gate warnings (declared use of a risky API); present only when there are some. */
  warnings?: string[];
  name: string;
  version: string;
  description: string;
  summary: string;
  license: string;
  repo: string;
  commit: string;
  /** sha256 (hex) of manifest.json, widget.json and layout.json at `commit`, as the registry build read them. Absent for fixtures. */
  sha256?: Record<string, string>;
  /** Committer date (yyyy-mm-dd, UTC) of the pinned commit; null when it could not be read. */
  updated: string | null;
  /** Primary category: the first entry of `categories`. */
  category: Category;
  /** 1 to 3 categories, primary first. The gallery lists the widget under each. */
  categories: Category[];
  tags: string[];
  status: Status;
  tier: Tier;
  /** What widget.json says about itself. Informational only, never trusted. */
  declaredTier: 'spec' | 'code';
  /** True only for alpha/stable entries. Planned entries are not installable. */
  installable: boolean;
  /** Present only when a matching maintainer review record covers this exact commit. */
  review: ReviewInfo | null;
  /** Set when a review record exists but was ignored (for example a stale commit). */
  reviewNote: string | null;
  surfaces: string[];
  sizeClasses: SizeClass[];
  variants: string[];
  providers: Provider[];
  capabilities: Capabilities;
  settings: Setting[];
  compat: { omarchy: string; widgetsKit: string };
  access: Access;
  /** Spec widgets only: the validated view tree and its sample data. Null for code widgets. */
  layout: Layout | null;
  sampleData: SampleData | null;
}

export interface RegistryIndex {
  schemaVersion: 1;
  /** Version recorded in registry/schema/PINNED.json. */
  widgetSchema: string;
  counts: {
    total: number;
    byStatus: Record<string, number>;
    byTier: Record<string, number>;
    byCategory: Record<string, number>;
  };
  widgets: RegistryWidget[];
  /** Listings left out of this build, with the reason. `pending` means awaiting a maintainer. */
  excluded: { ref: string; reason: string; pending: boolean }[];
}
