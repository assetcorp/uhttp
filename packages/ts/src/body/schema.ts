import { VALIDATION_ISSUE_COUNT, VALIDATION_MESSAGE_LENGTH, VALIDATION_PATH_SEGMENTS } from '../constants.js'
import { UhttpError, type ValidationIssue } from '../errors.js'

/**
 * A schema from any validator that implements Standard Schema v1, such as Valibot, Zod, or
 * ArkType, has this shape. You pass such a schema to `json(schema)`, and the package depends on no
 * validator.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The validator puts its Standard Schema interface under this key. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

/**
 * The types of Standard Schema v1, which the package copies from the specification at
 * standardschema.dev so that it depends on no package for them.
 */
export declare namespace StandardSchemaV1 {
  /** A validator implements Standard Schema through these properties. */
  export interface Props<Input = unknown, Output = Input> {
    /** The version of Standard Schema is 1. */
    readonly version: 1
    /** The validator writes its own name here, such as `valibot`. */
    readonly vendor: string
    /**
     * The validator checks a value with this function.
     *
     * @param value - The package passes the parsed body.
     * @returns The function returns the result, or a promise of the result.
     */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    /** The validator declares the input and the output types here, for inference alone. */
    readonly types?: Types<Input, Output> | undefined
  }

  /** A validation either succeeds with a value or fails with a list of problems. */
  export type Result<Output> = SuccessResult<Output> | FailureResult

  /** A successful validation returns the output value. */
  export interface SuccessResult<Output> {
    /** The validator returns this value, which can differ from the input when the schema transforms it. */
    readonly value: Output
    /** A successful result has no problems. */
    readonly issues?: undefined
  }

  /** A failed validation returns the problems that it found. */
  export interface FailureResult {
    /** The validator lists the problems here. */
    readonly issues: ReadonlyArray<Issue>
  }

  /** A validator returns each problem in this shape. */
  export interface Issue {
    /** The validator writes this message for the problem. */
    readonly message: string
    /** The validator reports this path from the root of the value to the value with the problem. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  /** A validator can write one segment of a path in this shape. */
  export interface PathSegment {
    /** The segment is this key. */
    readonly key: PropertyKey
  }

  /** The validator declares its input and output types in this shape. */
  export interface Types<Input = unknown, Output = Input> {
    /** You pass a value of this type to the schema. */
    readonly input: Input
    /** A successful validation returns a value of this type. */
    readonly output: Output
  }

  /** You get the output type of a schema from this type. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output']
}

function invalidSchema(message: string, cause?: unknown): UhttpError {
  return new UhttpError('INVALID_SCHEMA', message, cause === undefined ? undefined : { cause })
}

function standardPropsOf(schema: unknown): object | undefined {
  if ((typeof schema !== 'object' && typeof schema !== 'function') || schema === null) return undefined
  const props: unknown = Reflect.get(schema, '~standard')
  return typeof props === 'object' && props !== null ? props : undefined
}

function segmentOf(segment: unknown): string | number {
  const key = typeof segment === 'object' && segment !== null ? Reflect.get(segment, 'key') : segment
  if (typeof key === 'number' || typeof key === 'string') return key
  return String(key)
}

function issueOf(issue: unknown): ValidationIssue {
  const message = typeof issue === 'object' && issue !== null ? Reflect.get(issue, 'message') : undefined
  const path = typeof issue === 'object' && issue !== null ? Reflect.get(issue, 'path') : undefined
  return {
    message: String(message ?? 'The value is invalid.').slice(0, VALIDATION_MESSAGE_LENGTH),
    path: Array.isArray(path) ? path.slice(0, VALIDATION_PATH_SEGMENTS).map(segmentOf) : [],
  }
}

/**
 * Returns the output of a Standard Schema for a value. The function awaits the validator inside a
 * guard, and it throws a typed error when the validator throws or rejects.
 *
 * @param schema - The handler passes the schema.
 * @param value - The package passes the parsed body.
 * @returns The promise resolves to the output of the schema.
 * @throws {@link UhttpError} with the code `VALIDATION_FAILED` and the first 10 problems when the
 * value fails the schema, or with the code `INVALID_SCHEMA` when the schema lacks the Standard
 * Schema interface or when its validator throws, rejects, or returns something else.
 * @internal
 */
export async function validated(schema: unknown, value: unknown): Promise<unknown> {
  const props = standardPropsOf(schema)
  const validate: unknown = props === undefined ? undefined : Reflect.get(props, 'validate')
  if (props === undefined || typeof validate !== 'function') {
    throw invalidSchema('Pass json() a schema from a validator that implements Standard Schema v1.')
  }
  let result: unknown
  try {
    result = await Reflect.apply(validate, props, [value])
  } catch (error) {
    throw invalidSchema('The validator of the schema threw an error.', error)
  }
  if (typeof result !== 'object' || result === null) {
    throw invalidSchema('The validator of the schema returned something other than a Standard Schema result.')
  }
  const issues: unknown = Reflect.get(result, 'issues')
  if (issues === undefined) return Reflect.get(result, 'value')
  if (!Array.isArray(issues)) {
    throw invalidSchema('The validator of the schema returned issues that are not a list.')
  }
  throw new UhttpError('VALIDATION_FAILED', 'The request body failed validation.', {
    issues: issues.slice(0, VALIDATION_ISSUE_COUNT).map(issueOf),
  })
}
