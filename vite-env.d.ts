/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __VERSION__: string;
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __TEST_ENV__: Record<string, string>;

declare module '*.vue' {
	import type { DefineComponent } from 'vue';

	const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
	export default component;
}

declare module '@localSearchIndex' {
	const index: Record<string, () => Promise<{ default: string }>>;
	export default index;
}

// Vite virtual module synthesized by `adkDtsPlugin` (docs/.vitepress/config.mts):
// a map of @nhtio/adk .d.ts file contents fed to Monaco for in-editor types.
declare module 'virtual:adk-dts' {
	const dts: Record<string, string>;
	export default dts;
}

