export default {
	entry: './main.js',
	output: {
		filename: 'bundle.js',
		library: 'leakDetectToBeInjected',  // Name of var
	},

	resolve: {
		extensions: ['.js', '.mjs'],  // Resolve .mjs files in Fathom (no need for Babel)
	},
	module: {
		rules: [
			{
				test: /\.m?js$/,
				resolve: {
					fullySpecified: false,  // Do not require extensions in imports
				},
			},
		],
	},

	devtool: false,  // No source map
};
