const { getRegistryCreateCLIStatement, getSchemaCreateCLIStatement } = require('./awsCLIHelper');

const buildAWSCLIScript = (modelMetadata, openAPISchema, targetScriptOptions = {}) => {
	const registryStatement = getRegistryCreateCLIStatement({
		modelMetadata,
		isUpdateScript: targetScriptOptions.isUpdateScript,
	});
	const schemaStatement = getSchemaCreateCLIStatement({
		openAPISchema,
		modelMetadata,
		isUpdateScript: targetScriptOptions.isUpdateScript,
	});
	return [registryStatement, schemaStatement].join('\n\n');
};

module.exports = {
	buildAWSCLIScript,
};
