const getInfo = require('./helpers/infoHelper');
const { getPaths } = require('./helpers/pathHelper');
const getComponents = require('./helpers/componentsHelpers');
const commonHelper = require('./helpers/commonHelper');
const { getServers } = require('./helpers/serversHelper');
const getExtensions = require('./helpers/extensionsHelper');
const handleReferencePath = require('./helpers/handleReferencePath');
const mapJsonSchema = require('../reverse_engineering/helpers/adaptJsonSchema/mapJsonSchema');
const { addCommentsSigns, removeCommentLines } = require('./helpers/commentsHelper');
const { buildAWSCLIScript } = require('./helpers/awsCLIHelpers/buildAWSCLIScript');

const handleRefInContainers = (containers, externalDefinitions, resolveApiExternalRefs) => {
	return containers.map(container => {
		try {
			const updatedSchemas = Object.keys(container.jsonSchema).reduce((schemas, id) => {
				const json = container.jsonSchema[id];
				try {
					const updatedSchema = mapJsonSchema(
						JSON.parse(json),
						handleRef(externalDefinitions, resolveApiExternalRefs),
					);

					return {
						...schemas,
						[id]: JSON.stringify(updatedSchema),
					};
				} catch (err) {
					return { ...schemas, [id]: json };
				}
			}, {});

			return {
				...container,
				jsonSchema: updatedSchemas,
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

function generateModelScript(data, logger, cb) {
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
		const definitionsWithHandledReferences = mapJsonSchema(
			definitions,
			handleRef(externalDefinitions, resolveApiExternalRefs),
		);
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
			externalDocs,
		};
		const extensions = getExtensions(data.modelData[0].scopesExtensions);

		const resultSchema = { ...openApiSchema, ...extensions };
		let schema = addCommentsSigns(JSON.stringify(resultSchema, null, 2), 'json');
		schema = removeCommentLines(schema);

		const script = buildAWSCLIScript(modelMetadata, JSON.parse(schema), data.options);
		return cb(null, script);
	} catch (err) {
		logger.log('error', { error: err }, 'EventBridge FE Error');
		cb(err);
	}
}

module.exports = {
	generateModelScript,
};
