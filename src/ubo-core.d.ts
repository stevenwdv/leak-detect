declare module '@gorhill/ubo-core' {
	export class StaticNetFilteringEngine {
		constructor();

		static create(options?: { noPSL?: boolean }): Promise<StaticNetFilteringEngine>;

		static release(): Promise<void>;

		useLists(lists: (RawList | CompiledList | Promise<RawList | CompiledList>)[]): Promise<void>;

		matchRequest(details: RequestDetails): FilterResult;

		// More...
	}

	export interface RawList {
		name?: string;
		raw: string;
	}

	export interface CompiledList {
		name?: string;
		compiled: string;
	}

	export type RequestType =
		  | 'no_type'
		  | 'beacon'
		  | 'csp_report'
		  | 'font'
		  | 'image'
		  | 'imageset'
		  | 'main_frame'
		  | 'media'
		  | 'object'
		  | 'object_subrequest'
		  | 'ping'
		  | 'script'
		  | 'stylesheet'
		  | 'sub_frame'
		  | 'websocket'
		  | 'xmlhttprequest'
		  | 'inline-font'
		  | 'inline-script'
		  | 'other';

	export interface RequestDetails {
		originURL: string;
		url: string;
		type: RequestType;
	}

	export type FilterResult = 0 /*no match*/ | 1 /*block*/ | 2 /*allow*/;
}
