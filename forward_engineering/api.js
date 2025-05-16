const {
	SchemasClient,
	ListRegistriesCommand,
	UpdateRegistryCommand,
	DescribeRegistryCommand,
	CreateRegistryCommand,
	UpdateSchemaCommand,
	CreateSchemaCommand,
} = require('@aws-sdk/client-schemas');
const { hckFetchAwsSdkHttpHandler } = require('@hackolade/fetch');
const { getApiStatements, getItemUpdateParameters } = require('./helpers/awsCLIHelpers/applyToInstanceHelper');
const { SCHEMAS_CLIENT_API_VERSION, NOT_FOUND_RESPONSE_CODE } = require('../shared/constants');
const { generateModelScript } = require('./generateModelScript');
const { validate } = require('./validation/validate');

module.exports = {
	generateModelScript,
	validate,

	async applyToInstance(data, logger, callback) {
		if (!data.script) {
			return callback({ message: 'Empty script' });
		}

		logger.clear();
		logger.log('info', data, data.hiddenKeys);

		try {
			const { registry, schema } = getApiStatements(data.script);
			const schemasInstance = getSchemasInstance(data);

			if (registry) {
				try {
					if (registry.Description) {
						await schemasInstance.send(new UpdateRegistryCommand(getItemUpdateParameters(registry)));
					} else {
						await schemasInstance.send(
							new DescribeRegistryCommand({ RegistryName: registry.RegistryName }),
						);
					}
				} catch (err) {
					if (err.code === NOT_FOUND_RESPONSE_CODE) {
						await schemasInstance.send(new CreateRegistryCommand(registry));
					} else {
						return callback(err);
					}
				}
			}
			if (schema) {
				try {
					await schemasInstance.send(new UpdateSchemaCommand(getItemUpdateParameters(schema)));
				} catch (err) {
					if (err.code === NOT_FOUND_RESPONSE_CODE) {
						await schemasInstance.send(new CreateSchemaCommand(schema));
					} else {
						return callback(err);
					}
				}
			}
			callback();
		} catch (err) {
			callback(err);
		}
	},

	async testConnection(connectionInfo, logger, callback, app) {
		logger.log('info', connectionInfo, 'Test connection', connectionInfo.hiddenKeys);
		const schemasInstance = getSchemasInstance(connectionInfo);
		try {
			await schemasInstance.send(new ListRegistriesCommand());
			callback();
		} catch (err) {
			logger.log('error', { message: err.message, stack: err.stack, error: err }, 'Connection failed');
			callback(err);
		}
	},
};

const getSchemasInstance = connectionInfo => {
	const { accessKeyId, secretAccessKey, region, sessionToken, queryRequestTimeout } = connectionInfo;
	return new SchemasClient({
		credentials: {
			accessKeyId,
			secretAccessKey,
			sessionToken,
		},
		region,
		apiVersion: SCHEMAS_CLIENT_API_VERSION,
		requestHandler: hckFetchAwsSdkHttpHandler({ requestTimeout: queryRequestTimeout }),
	});
};
