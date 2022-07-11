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
				customCapture: (elem: HTMLInputElement) => ({
					time: Date.now(),
					value: elem.value,
					type: elem.type,
					id: elem.id,
				}),
			},
		],
		methods: [],
	},
];

export default breakpoints;
