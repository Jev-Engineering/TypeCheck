import type { ContentDefinition } from './content.js';
import type { RuleInput, Settings } from './domain.js';
export const PACK_FORMAT = 'typecheck-pack-v1';
export const PACK_LIMITS = { bytes: 48 * 1024 * 1024, assets: 250, expanded: 32 * 1024 * 1024, components: 1000 };
export type PackKind = 'groups' | 'images' | 'definitions' | 'rules';
export interface PackComponent {
    id: string;
    kind: PackKind;
    name: string;
    dependencies: string[];
    value: Record<string, any>;
}
export interface Pack {
    format: typeof PACK_FORMAT;
    id: string;
    version: string;
    description: string;
    compatibility: {
        app: string;
        schema: string;
        prompt: string;
        normalization: string;
        model: string;
    };
    provenance: {
        source: string;
        redistribution: string;
    };
    components: PackComponent[];
    assets: {
        id: string;
        sha256: string;
        base64: string;
        normalized?: string;
    }[];
    policy: {
        settings: Partial<Settings>;
        bindings: {
            id: string;
            kind: 'channel' | 'role';
            purpose: string;
        }[];
        grants: {
            role: string;
            capabilities: string[];
        }[];
    } | null;
    evidence: {
        kind: 'template' | 'human_review' | 'software' | 'model_evaluation' | 'live';
        digest: string;
        source: string;
        details: Record<string, unknown>;
    }[];
}
export interface Definition {
    name: string;
    content: ContentDefinition;
}
export interface PackSelection {
    complete?: boolean;
    components?: {
        kind: PackKind;
        id: string;
    }[];
    name?: string;
    version?: string;
}
export interface ImportOptions {
    choices?: Record<string, 'keep' | 'replace'>;
    mappings?: Record<string, string>;
    policy?: boolean;
    restoreDeleted?: boolean;
}
export interface PackPreview {
    token: string;
    digest: string;
    pack: {
        id: string;
        version: string;
        description: string;
    };
    components: {
        id: string;
        kind: PackKind;
        name: string;
        status: string;
        choice: string;
        dependencies: string[];
    }[];
    bindings: NonNullable<Pack['policy']>['bindings'];
    warnings: string[];
    evidence: {
        kind: string;
        status: string;
        source: string;
    }[];
    intendedRules: {
        name: string;
        policy: RuleInput;
    }[];
    intendedSettings: Partial<Settings> | null;
    policyChanges: {
        setting: string;
        destination: unknown;
        intended: unknown;
    }[];
    grants: {
        role: string;
        capabilities: string[];
        status: string;
    }[];
}
