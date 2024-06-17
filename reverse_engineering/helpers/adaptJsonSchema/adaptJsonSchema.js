const mapJsonSchema = require('./mapJsonSchema');
const commonHelper = require('../commonHelper');

const convertToString = jsonSchema => {
	return Object.assign({}, jsonSchema, {
		type: 'string',
		nullable: true,
	});
};

const convertMultipleTypeToType = jsonSchema => {
	const type = jsonSchema.type.find(item => item !== 'null');

	if (!type) {
		return convertToString(jsonSchema);
	} else if (!jsonSchema.type.includes('null')) {
		return {
			...jsonSchema,
			type,
		};
	}

	return {
		...jsonSchema,
		type,
		nullable: true,
	};
};

const adaptSchema = jsonSchema => {
	return mapJsonSchema(jsonSchema, jsonSchemaItem => {
		if (Array.isArray(jsonSchemaItem.type)) {
			return convertMultipleTypeToType(jsonSchemaItem);
		} else if (jsonSchemaItem.type !== 'null') {
			return jsonSchemaItem;
		}

		return convertToString(jsonSchemaItem);
	});
};

const adaptJsonSchema = (data, logger, callback) => {
	logger.log('info', 'Adaptation of JSON Schema started...', 'Adapt JSON Schema');
	try {
		const jsonSchema = JSON.parse(data.jsonSchema);

		const adaptedJsonSchema = adaptSchema(jsonSchema);

		logger.log('info', 'Adaptation of JSON Schema finished.', 'Adapt JSON Schema');

		callback(null, {
			jsonSchema: JSON.stringify(adaptedJsonSchema),
		});
	} catch (e) {
		callback(commonHelper.handleErrorObject(e, 'Adapt JSON Schema'), data);
	}
};

module.exports = { adaptJsonSchema };
