import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

let validator;

export function decisionValidator(schemaPath) {
  if (!validator) {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    // The schema declares draft 2020-12, so the matching Ajv build is required.
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(schema);
  }
  return validator;
}

/** Schema errors, flattened to the shape the linter reports. */
export function schemaFindings(data, schemaPath) {
  const validate = decisionValidator(schemaPath);
  if (validate(data)) return [];
  return validate.errors.map((error) => ({
    rule: 'schema',
    severity: 'error',
    // Name the stray key: "must NOT have additional properties" alone does not
    // say which one, and a judge retried on that message repeats the mistake.
    message: `${error.instancePath || '/'} ${error.message}${
      error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ''
    }`,
  }));
}
