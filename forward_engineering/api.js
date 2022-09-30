const aws = require('../reverse_engineering/node_modules/aws-sdk');
const validationHelper = require('./helpers/validationHelper');
const getInfo = require('./helpers/infoHelper');
const { getPaths } = require('./helpers/pathHelper');
const getComponents = require('./helpers/componentsHelpers');
const commonHelper = require('./helpers/commonHelper');
const { getServers } = require('./helpers/serversHelper');
const getExtensions = require('./helpers/extensionsHelper');
const { getRegistryCreateCLIStatement, getSchemaCreateCLIStatement } = require('./helpers/awsCLIHelpers/awsCLIHelper');
const { getApiStatements, getItemUpdateParamiters } = require('./helpers/awsCLIHelpers/applyToInstanceHelper');
const handleReferencePath = require('./helpers/handleReferencePath');
const mapJsonSchema = require('../reverse_engineering/helpers/adaptJsonSchema/mapJsonSchema');
const path=require('path');

module.exports = {
	generateModelScript(data, logger, cb) {
		try {
			const {
				dbVersion,
				externalDocs: modelExternalDocs,
				tags: modelTags,
				security: modelSecurity,
				servers: modelServers,
				...modelMetadata
			} = data.modelData[0];

			const containersIdsFromCallbacks = commonHelper.getContainersIdsForCallbacks(data);

			const resolveApiExternalRefs = data.options?.additionalOptions?.find(
				option => option.id === 'resolveApiExternalRefs',
			)?.value;

			const info = getInfo(data.modelData[0]);
			const servers = getServers(modelServers);
			const externalDefinitions = JSON.parse(data.externalDefinitions || '{}').properties || {};
			const containers = handleRefInContainers(data.containers, externalDefinitions, resolveApiExternalRefs);
			const paths = getPaths(containers, containersIdsFromCallbacks);
			const definitions = JSON.parse(data.modelDefinitions) || {};
			const definitionsWithHandledReferences = mapJsonSchema(definitions, handleRef(externalDefinitions, resolveApiExternalRefs));
			const components = getComponents(definitionsWithHandledReferences, data.containers);
			const security = commonHelper.mapSecurity(modelSecurity);
			const tags = commonHelper.mapTags(modelTags);
			const externalDocs = commonHelper.mapExternalDocs(modelExternalDocs);

			const openApiSchema = {
				openapi: '3.0.0',
				info,
				servers,
				paths,
				components,
				security,
				tags,
				externalDocs
			};
			const extensions = getExtensions(data.modelData[0].scopesExtensions);

			const resultSchema = Object.assign({}, openApiSchema, extensions);
			let schema = addCommentsSigns(JSON.stringify(resultSchema, null, 2), 'json');
			schema = removeCommentLines(schema);

			const script = buildAWSCLIScript(modelMetadata, JSON.parse(schema), data.options);
			return cb(null, script);
		} catch (err) {
			logger.log('error', { error: err }, 'EventBridge FE Error');
			cb(err);
		}
	},

	validate(data, logger, cb) {
		const { script, targetScriptOptions } = data;
		try {
			const { schema } = getApiStatements(script);
			let openAPISchema = JSON.parse(replaceRelativePathByAbsolute(schema.Content,targetScriptOptions));

			validationHelper.validate(openAPISchema)
				.then((messages) => {
					cb(null, messages);
				})
				.catch(err => {
					cb(err.message);
				});
		} catch (e) {
			logger.log('error', { error: e }, 'EventBridge Schema Validation Error');

			cb(e.message);
		}
	},

	async applyToInstance(data, logger, callback, app) {
		const NOT_FOUND_RESPONSE_CODE = 'NotFoundException';
		const BAD_REQUEST_RESPONSE_CODE = 'BadRequestException';
		const NOTHING_TO_UPDATE_RESPONSE_MESSAGE = 'Invalid request. Please provide at least one field to update.';
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
						await schemasInstance.updateRegistry((getItemUpdateParamiters(registry))).promise();
					} else {
						await schemasInstance.describeRegistry({ RegistryName: registry.RegistryName }).promise();
					}
				} catch (err) {
					if (err.code === NOT_FOUND_RESPONSE_CODE) {
						await schemasInstance.createRegistry(registry).promise();
					} else {
						return callback(err);
					}
				}
			}
			if (schema) {
				try {
					await schemasInstance.updateSchema(getItemUpdateParamiters(schema)).promise();
				} catch (err) {
					if (err.code === NOT_FOUND_RESPONSE_CODE) {
						await schemasInstance.createSchema(schema).promise();
					}
					else {
						return callback(err);
					}
				}
			}
			callback();
		} catch(err) {
			callback(err);
		}
	},

	async testConnection(connectionInfo, logger, callback, app) {
		logger.log('info', connectionInfo, 'Test connection', connectionInfo.hiddenKeys);
		const schemasInstance = getSchemasInstance(connectionInfo);
		try {
			await schemasInstance.listRegistries().promise();
			callback();
		} catch (err) {
			logger.log('error', { message: err.message, stack: err.stack, error: err }, 'Connection failed');
			callback(err);
		}
	}
};

const replaceRelativePathByAbsolute=(script, options)=>{
	const modelDirectory=options?options.modelDirectory:'';
	if(!modelDirectory || typeof modelDirectory !== 'string'){
		return script;
	}
	return script.replace(/("\$ref":\s*)"(.*?(?<!\\))"/g, (match, refGroup, relativePath)=>{
        const isAbsolutePath=relativePath.startsWith('file:');
        const isInternetLink=relativePath.startsWith('http:') || relativePath.startsWith('https:');
        const isModelRef=relativePath.startsWith('#');

        if(isAbsolutePath || isInternetLink || isModelRef){
            return match
        }
		
        const absolutePath=path.join(path.dirname(modelDirectory), relativePath).replace(/\\/g, '/');
        return `${refGroup}"file://${absolutePath}"`
    });
}

const addCommentsSigns = (string, format) => {
	const commentsStart = /hackoladeCommentStart\d+/i;
	const commentsEnd = /hackoladeCommentEnd\d+/i;
	const innerCommentStart = /hackoladeInnerCommentStart/i;
	const innerCommentEnd = /hackoladeInnerCommentEnd/i;
	const innerCommentStartYamlArrayItem = /- hackoladeInnerCommentStart/i;
	
	const { result } = string.split('\n').reduce(({ isCommented, result }, line, index, array) => {
		if (commentsStart.test(line) || innerCommentStart.test(line)) {
			if (innerCommentStartYamlArrayItem.test(line)) {
				const lineBeginsAt = array[index + 1].search(/\S/);
				array[index + 1] = array[index + 1].slice(0, lineBeginsAt) + '- ' + array[index + 1].slice(lineBeginsAt);
			}
			return { isCommented: true, result: result };
		}
		if (commentsEnd.test(line)) {
			return { isCommented: false, result };
		}
		if (innerCommentEnd.test(line)) {
			if (format === 'json') {
				array[index + 1] = '# ' + array[index + 1];
			}
			return { isCommented: false, result };
		}

		const isNextLineInnerCommentStart = index + 1 < array.length && innerCommentStart.test(array[index + 1]);
		if ((isCommented || isNextLineInnerCommentStart) && !innerCommentStartYamlArrayItem.test(array[index + 1])) {
			result = result + '# ' + line + '\n';
		} else {
			result = result + line + '\n';
		}

		return { isCommented, result };
	}, { isCommented: false, result: '' });

	return result;
}

const removeCommentLines = (scriptString) => {
	const isCommentedLine = /^\s*#\s+/i;

	return scriptString
		.split('\n')
		.filter(line => !isCommentedLine.test(line))
		.join('\n')
		.replace(/(.*?),\s*(\}|])/g, '$1$2');
}

const buildAWSCLIScript = (modelMetadata, openAPISchema, targetScriptOptions = {}) => {
	const registryStatement = getRegistryCreateCLIStatement({ modelMetadata, isUpdateScript: targetScriptOptions.isUpdateScript });
	const schemaStatement = getSchemaCreateCLIStatement({ openAPISchema, modelMetadata, isUpdateScript: targetScriptOptions.isUpdateScript });
	return [registryStatement, schemaStatement].join('\n\n');
}

const getSchemasInstance = (connectionInfo) => {
	const { accessKeyId, secretAccessKey, region, sessionToken } = connectionInfo;
	aws.config.update({ accessKeyId, secretAccessKey, region, sessionToken });
	return new aws.Schemas({apiVersion: '2019-12-02'});
}

const handleRefInContainers = (containers, externalDefinitions, resolveApiExternalRefs) => {
	return containers.map(container => {
		try {
			const updatedSchemas = Object.keys(container.jsonSchema).reduce((schemas, id) => {
				const json = container.jsonSchema[id];
				try {
					const updatedSchema = mapJsonSchema(JSON.parse(json), handleRef(externalDefinitions, resolveApiExternalRefs));

					return {
						...schemas,
						[id]: JSON.stringify(updatedSchema)
					};
				} catch (err) {
					return { ...schemas, [id]: json }
				}
			}, {});

			return {
				...container,
				jsonSchema: updatedSchemas
			};
		} catch (err) {
			return container;
		}
	});
};


const handleRef = (externalDefinitions, resolveApiExternalRefs) => field => {
	if (!field.$ref) {
		return field;
	}
	const ref = handleReferencePath(externalDefinitions, field, resolveApiExternalRefs);
	if (!ref.$ref) {
		return ref;
	}

	return { ...field, ...ref }; 
};
