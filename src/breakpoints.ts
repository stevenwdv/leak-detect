import {PageVars} from './FieldsCollector';
import type {SelectorChain} from 'leak-detect-inject';

export const breakpoints: import('tracker-radar-collector').breakpoints.BreakpointObject[] = [
	{
		proto: 'HTMLInputElement',
		props: [
			{
				name: 'value',
				test: 'const e = document.createElement("input"); e.value;',
				saveArguments: true,
				fullStack: true,
				condition: (elem: HTMLInputElement) => ['email', 'password', 'text'].includes(elem.type),
				pauseDebugger: true,
				customCapture: (elem: HTMLInputElement): LeakDetectorCaptureData => ({
					time: Date.now(),
					value: elem.value,
					type: elem.type,
					selectorChain: (window[PageVars.INJECTED] as typeof window[PageVars.INJECTED] | undefined)
						  ?.formSelectorChain(elem),
				}),
			},
		],
		methods: [],
	},
];

export default breakpoints;

export interface LeakDetectorCaptureData {
	time: number;
	value: string;
	type: string;
	selectorChain?: SelectorChain | undefined;
}
