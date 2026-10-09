/**
 * dsh-windows-shell-policy — Windows 默认 Shell 策略组合插件（host 侧）。
 *
 * 职责：
 * 1. 探测 git-bash / MSYS2 / Cygwin 可执行文件（显式 bashPath → 常见安装路径 → PATH）。
 * 2. 通过 settings namespace `shell-policy` 暴露 preferred（auto/bash/pwsh）与
 *    bashPath 配置，在「设置 - 插件 - 插件配置」面板由 client 卡片编辑。
 * 3. 策略生效：effective=bash 时动态注册 `bash` 工具（git-bash 执行），
 *    并在 system-prompt/assemble 中裁剪掉 `pwsh` 工具；effective=pwsh 时注销
 *    bash 工具并裁剪掉 `bash`（官方 tool-pwsh 继续工作）。
 * 4. bash 工具对齐官方 shell 工具：session cwd 解析、文件沙箱（confine +
 *    sandbox_permissions 升级）、run_in_background（jobs 通道）、终端卡片展示。
 * 5. 提供 /dsh-shell-policy/api 供 client 卡片读写状态与配置（仅接受本机 GUI 来源请求）。
 * 6. 非 Windows 平台直接跳过（DSH 默认 bash 工具已可用），仅保留状态 API。
 */
import type { Context, Volatile } from 'cordis';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        bash: 'bash';
    }
}
export declare const name = "dsh-windows-shell-policy";
export declare const inject: string[];
export interface Config {
    /**
     * 首选 shell：auto（探测到 bash 则用 bash，否则 pwsh）/ bash / pwsh。
     * DSH 0.2.0 起 live 配置必须是 volatile 引用（settings 从 Config schema 投影表单），
     * 读取时用 {@link unwrapVolatile} 解包。
     */
    preferred: Volatile<'auto' | 'bash' | 'pwsh'>;
    /** 显式 bash 可执行文件路径；留空则自动探测。 */
    bashPath: Volatile<string>;
}
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
    preferred: import("@deepseek-ai/schemastery").default<"bash" | "auto" | "pwsh", "bash" | "auto" | "pwsh", (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") extends infer T ? T extends (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") ? T extends "defined" | "volatile-defined" ? "volatile-defined" : "volatile" : never : never>;
    bashPath: import("@deepseek-ai/schemastery").default<string, string, (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") extends infer T_1 ? T_1 extends (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") ? T_1 extends "defined" | "volatile-defined" ? "volatile-defined" : "volatile" : never : never>;
}>>, Schemastery.ObjectT<NoInfer<{
    preferred: import("@deepseek-ai/schemastery").default<"bash" | "auto" | "pwsh", "bash" | "auto" | "pwsh", (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") extends infer T_2 ? T_2 extends (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") ? T_2 extends "defined" | "volatile-defined" ? "volatile-defined" : "volatile" : never : never>;
    bashPath: import("@deepseek-ai/schemastery").default<string, string, (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") extends infer T_3 ? T_3 extends (Mode extends "volatile" | "volatile-defined" ? "volatile-defined" : "defined") ? T_3 extends "defined" | "volatile-defined" ? "volatile-defined" : "volatile" : never : never>;
}>>, "plain">;
/** 本插件消费的 host 服务面（webServer 类型由本包声明）。 */
type AppContext = Context & {
    webServer: {
        register(spec: {
            kind: 'prefix';
            path: string;
            handler: (req: any, res: {
                writeHead(code: number, headers: Record<string, string>): void;
                end(body: string): void;
            }) => void | Promise<void>;
        }): () => void;
    };
};
export declare function apply(ctx: AppContext, config: Config): void;
export {};
