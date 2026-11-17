export interface SettingField {
    path: string;
    label: string;
    group: string;
    type: 'boolean' | 'number';
    min?: number;
    max?: number;
    hint?: string;
}
/** 设置弹窗与 Config schema 共用的唯一字段表；新增开关只改这里。 */
export declare const SETTINGS_FIELDS: readonly SettingField[];
export declare function settingField(path: string): SettingField | undefined;
export declare function getPath(obj: unknown, path: string): unknown;
export declare function setPath(obj: Record<string, unknown>, path: string, value: unknown): void;
export declare function deletePath(obj: Record<string, unknown>, path: string): void;
export declare function coerceSetting(field: SettingField, value: unknown): boolean | number | undefined;
export declare function settingsSnapshot(config: unknown, overrides: Record<string, unknown>): {
    value: unknown;
    overridden: boolean;
    path: string;
    label: string;
    group: string;
    type: "boolean" | "number";
    min?: number;
    max?: number;
    hint?: string;
}[];
