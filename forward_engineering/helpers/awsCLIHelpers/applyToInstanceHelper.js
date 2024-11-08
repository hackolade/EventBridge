const { CLI, CREATE_REGISTRY, CREATE_SCHEMA, UPDATE_REGISTRY, UPDATE_SCHEMA } = require('./cliConstants');

const registryRegexp = new RegExp(`${CLI} (${CREATE_REGISTRY}|${UPDATE_REGISTRY}) '(.*})'`, 'i');
const schemaRegexp = new RegExp(`${CLI} (${CREATE_SCHEMA}|${UPDATE_SCHEMA}) '(.*})'`, 'i');

const getApiStatements = script => {
	const cliStatements = script.split('\n\n');

	return cliStatements.reduce((acc, statement) => {
		const oneLineStatement = statement.replace(/\n/g, '');
		if (registryRegexp.test(oneLineStatement)) {
			acc.registry = getStatementInput(registryRegexp, oneLineStatement);
		} else if (schemaRegexp.test(oneLineStatement)) {
			acc.schema = getStatementInput(schemaRegexp, oneLineStatement);
		}
		return acc;
	}, {});
};

const getStatementInput = (regExp, statement) => {
	const jsonInput = regExp.exec(statement)[2];
	return JSON.parse(jsonInput);
};

const getItemUpdateParameters = data => {
	const { Tags, ...parameters } = data;
	return parameters;
};

module.exports = {
	getApiStatements,
	getItemUpdateParameters,
};
