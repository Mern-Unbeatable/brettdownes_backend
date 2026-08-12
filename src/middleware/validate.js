import { badRequest } from '../lib/http-error.js'

function firstIssueMessage(error) {
  const issue = error.issues?.[0]
  if (!issue) return 'Invalid request.'
  const path = issue.path?.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/** Replaces req[source] with the parsed/coerced result, or throws a 400. */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      return next(
        badRequest(firstIssueMessage(result.error), {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      )
    }
    // Express 5 exposes req.query as a getter, so assign onto a scratch field.
    if (source === 'query') {
      req.validatedQuery = result.data
    } else {
      req[source] = result.data
    }
    next()
  }
}
