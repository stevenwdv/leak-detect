export const breakpoints: import('tracker-radar-collector').breakpoints.BreakpointObject[] = [
	{
		proto: 'HTMLInputElement',
		props: [
			{
				name: 'value',
				test: 'const e = document.createElement("input"); e.value;',
				saveArguments: true,
				condition: '["email", "password", "text"].includes(this.type)',
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
