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

	// Combination of:
	// https://help.eyeo.com/en/adblockplus/how-to-write-filters#type-options
	// filtering-context.js: typeStrToIntMap
	// static-net-filtering.js: typeNameToTypeValue, typeValueToTypeName
	// I hope this is correct
	export type RequestType =
		  | 'no_type'
		  | 'beacon'
		  | 'cname'
		  | 'csp_report'
		  | 'document'
		  | 'elemhide'
		  | 'fetch'
		  | 'font'
		  | 'genericblock'
		  | 'generichide'
		  | 'image'
		  | 'imageset'
		  | 'main_frame'
		  | 'match-case'
		  | 'media'
		  | 'object'
		  | 'object_subrequest'
		  | 'ping'
		  | 'popunder'
		  | 'popup'
		  | 'script'
		  | 'specifichide'
		  | 'stylesheet'
		  | 'sub_frame'
		  | 'subdocument'
		  | 'webrtc'
		  | 'websocket'
		  | 'xmlhttprequest'
		  | 'inline-font'
		  | 'inline-script'
		  | 'other'
		  | 'unsupported';

	export interface RequestDetails {
		originURL: string;
		url: string;
		type: RequestType;
	}

	export type FilterResult = 0 /*no match*/ | 1 /*block*/ | 2 /*allow*/;
}
