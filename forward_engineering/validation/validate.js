const path = require('path');
const validationHelper = require('../validation/validationHelper');
const { getApiStatements } = require('../helpers/awsCLIHelpers/applyToInstanceHelper');

const replaceRelativePathByAbsolute = (script, options) => {
	const modelDirectory = options ? options.modelDirectory : '';
	if (!modelDirectory || typeof modelDirectory !== 'string') {
		return script;
	}
	return script.replace(/("\$ref":\s*)"(.*?(?<!\\))"/g, (match, refGroup, relativePath) => {
		const isAbsolutePath = relativePath.startsWith('file:');
		const isInternetLink = relativePath.startsWith('http:') || relativePath.startsWith('https:');
		const isModelRef = relativePath.startsWith('#');

		if (isAbsolutePath || isInternetLink || isModelRef) {
			return match;
		}

		const absolutePath = path.join(path.dirname(modelDirectory), relativePath).replace(/\\/g, '/');
		return `${refGroup}"file://${absolutePath}"`;
	});
};

function validate(data, logger, cb) {
	const { script, targetScriptOptions } = data;
	try {
		const { schema } = getApiStatements(script);
		let openAPISchema = JSON.parse(replaceRelativePathByAbsolute(schema.Content, targetScriptOptions));

		validationHelper
			.validate(openAPISchema)
			.then(messages => {
				cb(null, messages);
			})
			.catch(err => {
				cb(err.message);
			});
	} catch (e) {
		logger.log('error', { error: e }, 'EventBridge Schema Validation Error');

		cb(e.message);
	}
}

module.exports = {
	validate,
};
