'use strict';

const {
	SchemasClient,
	ListRegistriesCommand,
	ListSchemasCommand,
	DescribeRegistryCommand,
	DescribeSchemaCommand,
	ListSchemaVersionsCommand,
} = require('@aws-sdk/client-schemas');
const fs = require('fs');
const https = require('https');
const { hckFetchAwsSdkHttpHandler } = require('@hackolade/fetch');
const commonHelper = require('./helpers/commonHelper');
const dataHelper = require('./helpers/dataHelper');
const errorHelper = require('./helpers/errorHelper');
const { adaptJsonSchema } = require('./helpers/adaptJsonSchema/adaptJsonSchema');
const resolveExternalDefinitionPathHelper = require('./helpers/resolveExternalDefinitionPathHelper');
const validationHelper = require('../forward_engineering/helpers/validationHelper');
const { SCHEMAS_CLIENT_API_VERSION } = require('../shared/constants');

let schemasInstance = null;

module.exports = {
	connect: async (connectionInfo, logger, cb) => {
		const { accessKeyId, secretAccessKey, region, sessionToken, queryRequestTimeout } = connectionInfo;
		const sslOptions = await getSslOptions(connectionInfo);
		const httpOptions = sslOptions.ssl
			? {
					httpOptions: {
						agent: new https.Agent({
							rejectUnauthorized: true,
							...sslOptions,
						}),
					},
					...sslOptions,
				}
			: {};
		schemasInstance = new SchemasClient({
			credentials: {
				accessKeyId,
				secretAccessKey,
				sessionToken,
			},
			region,
			apiVersion: SCHEMAS_CLIENT_API_VERSION,
			requestHandler: hckFetchAwsSdkHttpHandler({ requestTimeout: queryRequestTimeout }),
		});

		cb(schemasInstance);
	},

	disconnect: function (connectionInfo, logger, cb) {
		schemasInstance?.destroy?.();
		cb();
	},

	testConnection: function (connectionInfo, logger, cb, app) {
		logInfo('Test connection', connectionInfo, logger);
		const connectionCallback = async schemasInstance => {
			try {
				await schemasInstance.send(new ListRegistriesCommand());
				cb();
			} catch (err) {
				logger.log('error', { message: err.message, stack: err.stack, error: err }, 'Connection failed');
				cb(err);
			}
		};

		this.connect(connectionInfo, logger, connectionCallback, app);
	},

	getDbCollectionsNames: function (connectionInfo, logger, cb, app) {
		const connectionCallback = async schemasInstance => {
			try {
				const registries = await listRegistries(schemasInstance);
				const registrySchemas = registries.map(async registry => {
					const schemas = await listSchemas(schemasInstance, registry.RegistryName);
					const schemaNames = schemas.map(({ SchemaName }) => SchemaName);
					const dbCollectionsChildrenCount = schemas.reduce((acc, { SchemaName, VersionCount }) => {
						acc[SchemaName] = VersionCount;
						return acc;
					}, {});
					return {
						dbName: registry.RegistryName,
						dbCollections: schemaNames,
						isEmpty: schemaNames.length === 0,
						dbCollectionsChildrenCount,
					};
				});
				const result = await Promise.all(registrySchemas);
				cb(null, result);
			} catch (err) {
				logger.log(
					'error',
					{ message: err.message, stack: err.stack, error: err },
					'Retrieving databases and tables information',
				);
				cb({ message: err.message, stack: err.stack });
			}
		};

		logInfo('Retrieving databases and tables information', connectionInfo, logger);
		this.connect(connectionInfo, logger, connectionCallback, app);
	},

	getDbCollectionsData: function (data, logger, cb) {
		logger.log('info', data, 'Retrieving schema', data.hiddenKeys);

		const { collectionData } = data;
		const registries = collectionData.dataBaseNames;
		const schemas = collectionData.collections;
		const registryName = registries[0];
		const schemaName = schemas[registryName][0];
		const schemaVersion = collectionData.collectionVersion[registryName]?.[schemaName];

		const getSchema = async () => {
			try {
				const registryData = await schemasInstance.send(
					new DescribeRegistryCommand({ RegistryName: registryName }),
				);
				const schemaData = await schemasInstance.send(
					new DescribeSchemaCommand({
						RegistryName: registryName,
						SchemaName: schemaName,
						SchemaVersion: schemaVersion,
					}),
				);

				const openAPISchema = JSON.parse(schemaData.Content);
				const { modelData, modelContent, definitions } = convertOpenAPISchemaToHackolade(openAPISchema);
				const eventbridgeModelLevelData = {
					ESBRregistry: registryName,
					EBSRregistryDescription: registryData.Description,
					EBSRschemaDescription: schemaData.Description,
					ESBRschemaARN: schemaData.SchemaArn,
					ESBRregistryARN: registryData.RegistryArn,
					EBSRschemaVersion: schemaData.SchemaVersion,
					EBSRRegistryTags: mapEBSRTags(registryData.Tags),
					EBSRSchemaTags: mapEBSRTags(schemaData.Tags),
					EBSRversionCreatedDate: schemaData.VersionCreatedDate,
					EBSRlastModified: schemaData.LastModified,
					modelName: schemaName,
				};
				const modelLevelData = { ...modelData, ...eventbridgeModelLevelData };
				const modelDefinitions = JSON.parse(definitions);
				const packagesData = mapPackageData(modelContent);
				if (packagesData.length === 0) {
					packagesData[0] = { modelDefinitions };
				} else {
					packagesData[0] = { ...packagesData[0], modelDefinitions };
				}

				cb(null, packagesData, modelLevelData);
			} catch (err) {
				logger.log(
					'error',
					{ message: err.message, stack: err.stack, error: err },
					'Retrieving databases and tables information',
				);
				cb({ message: err.message, stack: err.stack });
			}
		};

		getSchema();
	},

	reFromFile(data, logger, callback) {
		commonHelper
			.getFileData(data.filePath)
			.then(fileData => {
				return getOpenAPISchema(fileData, data.filePath);
			})
			.then(openAPISchema => {
				const fieldOrder = data.fieldInference.active;
				return handleOpenAPIData(openAPISchema, fieldOrder);
			})
			.then(
				reversedData => {
					return callback(null, reversedData.hackoladeData, reversedData.modelData, [], 'multipleSchema');
				},
				({ error, openAPISchema }) => {
					if (!openAPISchema) {
						return this.handleErrors(error, logger, callback);
					}

					validationHelper
						.validate(filterSchema(openAPISchema), { resolve: { external: false } })
						.then(messages => {
							if (!Array.isArray(messages) || !messages.length) {
								this.handleErrors(error, logger, callback);
							}

							const message = `${messages[0].label}: ${messages[0].title}`;
							const errorData = error.error || {};

							this.handleErrors(
								errorHelper.getValidationError({ stack: errorData.stack, message }),
								logger,
								callback,
							);
						})
						.catch(err => {
							this.handleErrors(error, logger, callback);
						});
				},
			)
			.catch(errorObject => {
				this.handleErrors(errorObject, logger, callback);
			});
	},

	handleErrors(errorObject, logger, callback) {
		const { error, title } = errorObject;
		const handledError = commonHelper.handleErrorObject(error, title);
		logger.log('error', handledError, title);
		callback(handledError);
	},

	adaptJsonSchema,

	resolveExternalDefinitionPath(data, logger, callback) {
		resolveExternalDefinitionPathHelper.resolvePath(data, callback);
	},

	getDBCollectionVersions(data, logger, callback) {
		const getSchemaVersions = async () => {
			const { containerName, entityName } = data;
			try {
				const schemaVersionsResponse = await schemasInstance.send(
					new ListSchemaVersionsCommand({
						RegistryName: containerName,
						SchemaName: entityName,
					}),
				);
				const schemaVersions = schemaVersionsResponse.SchemaVersions.map(({ SchemaVersion }) => ({
					name: SchemaVersion,
				}));
				callback(null, { collectionVersions: schemaVersions });
			} catch (err) {
				logger.log(
					'error',
					{ message: err.message, stack: err.stack, error: err },
					'Retrieving schema versions',
				);
				callback({ message: err.message, stack: err.stack });
			}
		};

		getSchemaVersions();
	},
};

const convertOpenAPISchemaToHackolade = (openAPISchema, fieldOrder) => {
	const modelData = dataHelper.getModelData(openAPISchema);
	const components = openAPISchema.components;
	const definitions = dataHelper.getComponents(openAPISchema.components, fieldOrder);
	const callbacksComponent = components && components.callbacks;
	const modelContent = dataHelper.getModelContent(openAPISchema.paths || {}, fieldOrder, callbacksComponent);
	return { modelData, modelContent, definitions };
};

const getOpenAPISchema = (data, filePath) =>
	new Promise((resolve, reject) => {
		const { extension, fileName } = commonHelper.getPathData(data, filePath);

		try {
			const openAPISchemaWithModelName = dataHelper.getOpenAPIJsonSchema(data, fileName, extension);
			const isValidOpenAPISchema = dataHelper.validateOpenAPISchema(openAPISchemaWithModelName);

			if (isValidOpenAPISchema) {
				return resolve(openAPISchemaWithModelName);
			} else {
				return reject({
					error: errorHelper.getValidationError(
						new Error('Selected file is not a valid OpenAPI 3.0.x schema'),
					),
				});
			}
		} catch (error) {
			return reject({ error: errorHelper.getParseError(error) });
		}
	});

const handleOpenAPIData = (openAPISchema, fieldOrder) =>
	new Promise((resolve, reject) => {
		try {
			const convertedData = convertOpenAPISchemaToHackolade(openAPISchema, fieldOrder);
			const { modelData, modelContent, definitions } = convertedData;
			const hackoladeData = modelContent.containers.reduce((accumulator, container) => {
				const currentEntities = modelContent.entities[container.name];
				return [
					...accumulator,
					...currentEntities.map(entity => {
						const packageData = {
							objectNames: {
								collectionName: entity.collectionName,
							},
							doc: {
								dbName: container.name,
								collectionName: entity.collectionName,
								modelDefinitions: definitions,
								bucketInfo: container,
							},
							jsonSchema: JSON.stringify(entity),
						};
						return packageData;
					}),
				];
			}, []);
			if (hackoladeData.length) {
				return resolve({ hackoladeData, modelData });
			}

			return resolve({
				hackoladeData: [
					{
						objectNames: {},
						doc: { modelDefinitions: definitions },
					},
				],
				modelData,
			});
		} catch (error) {
			return reject({ error: errorHelper.getConvertError(error), openAPISchema });
		}
	});

const filterSchema = schema => {
	delete schema.modelName;

	return schema;
};

const logInfo = (step, connectionInfo, logger) => {
	logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
};

const mapEBSRTags = (tags = {}) => {
	return Object.entries(tags).reduce((acc, [key, value]) => {
		return acc.concat({ EBSRtagKey: key, EBSRtagValue: value });
	}, []);
};

const mapPackageData = data => {
	return Object.entries(data.entities).reduce((acc, [containerName, containerEntities]) => {
		const entities = containerEntities.map(entity => {
			const { collectionName, properties, ...entityLevel } = entity;
			const { bucketInfo } = data.containers.find(item => item.name === containerName);
			return {
				dbName: containerName,
				collectionName,
				bucketInfo,
				entityLevel,
				documents: [],
				validation: {
					jsonSchema: { properties },
				},
			};
		});
		return acc.concat(...entities);
	}, []);
};

const listRegistries = async schemasInstance => {
	let { NextToken, Registries } = await schemasInstance.send(new ListRegistriesCommand());
	const registries = [...Registries];
	let nextToken = NextToken;
	while (nextToken) {
		const { NextToken, Registries } = await schemasInstance.send(
			new ListRegistriesCommand({ NextToken: nextToken }),
		);
		registries.push(...Registries);
		nextToken = NextToken;
	}
	return registries;
};

const listSchemas = async (schemasInstance, registryName) => {
	const { NextToken, Schemas } = await schemasInstance.send(new ListSchemasCommand({ RegistryName: registryName }));
	const schemas = [...Schemas];
	let nextToken = NextToken;
	while (nextToken) {
		const { NextToken, Schemas } = await schemasInstance.send(
			new ListSchemasCommand({ RegistryName: registryName, NextToken: nextToken }),
		);
		schemas.push(...Schemas);
		nextToken = NextToken;
	}
	return schemas;
};

const readCertificateFile = path => {
	if (!path) {
		return Promise.resolve('');
	}

	return new Promise(resolve => {
		fs.readFile(path, 'utf8', (err, data) => {
			if (err) {
				resolve('');
			}
			resolve(data);
		});
	});
};

const getSslOptions = async connectionInfo => {
	switch (connectionInfo.sslType) {
		case 'Server validation': {
			const certAuthority = await readCertificateFile(connectionInfo.certAuthorityPath);
			return {
				ssl: true,
				ca: [certAuthority],
			};
		}
		case 'Server and client validation': {
			const certAuthority = await readCertificateFile(connectionInfo.certAuthorityPath);
			const key = await readCertificateFile(connectionInfo.clientPrivateKey);
			const cert = await readCertificateFile(connectionInfo.clientCert);
			return {
				ssl: true,
				ca: [certAuthority],
				key: [key],
				cert: [cert],
				passphrase: connectionInfo.clientKeyPassword,
			};
		}
		default:
			return { ssl: false };
	}
};
