import TerserPlugin from 'terser-webpack-plugin';

export default {
	entry: './src/main.ts',
	output: {
		filename: 'bundle.js',
		library: 'leakDetectInject',  // Name of var
	},

	resolve: {
		extensions: ['.ts', '.mjs', '.js'],  // Resolve .mjs files in Fathom (no need for Babel)
	},
	module: {
		rules: [
			{
				test: /\.m?js$/i,
				resolve: {
					fullySpecified: false,  // Do not require extensions in imports
				},
			},
			{
				test: /\.ts$/i,
				use: [{
					loader: 'ts-loader',
					options: {
						compilerOptions: {
							noEmit: false,
							emitDeclarationOnly: false,
						},
					},
				}],
			},
		],
	},

	optimization: {
		minimizer: [
			new TerserPlugin({
				parallel: true,
				terserOptions: {
					mangle: {
						keep_classnames: true,
						keep_fnames: true,
					},
				},
			}),
		],
	},
	devtool: false,  // No source map
};
