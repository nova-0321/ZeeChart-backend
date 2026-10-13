import Joi from 'joi';

/** Signs tokens in tests only (NODE_ENV=test): never accepted anywhere else. */
export const TEST_JWT_SECRET = 'zeechart-test-only-secret-never-use-elsewhere-0001';
/** Secrets that have been in the repository, so are known to everyone. */
const PUBLIC_JWT_SECRETS = ['zeechart-development-secret-not-for-production', TEST_JWT_SECRET];

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGIN: Joi.string().default('http://127.0.0.1:5173'),

  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  DB_LOGGING: Joi.boolean().default(false),
  // SSL to the database: false (local), true (a managed host: Neon, Railway…; the certificate is
  // checked), or no-verify (encrypted, certificate not checked: a host whose certificate isn't
  // publicly trusted, e.g. Supabase's pooler).
  DB_SSL: Joi.string().valid('false', 'true', 'no-verify').default('false'),

  // Signs the sign-in tokens: anyone who knows it can sign in as anyone. Required (32+ random
  // characters) everywhere but tests, development included: a default would also apply to a server
  // whose NODE_ENV was simply never set. The value that used to be the default is public (it was in
  // this file), so it is refused. Tests get a fixed value of their own. Changing it signs everyone
  // out.
  JWT_SECRET: Joi.when('NODE_ENV', {
    is: 'test',
    then: Joi.string().min(32).default(TEST_JWT_SECRET),
    otherwise: Joi.string()
      .min(32)
      .invalid(...PUBLIC_JWT_SECRETS)
      .required()
      .messages({
        'any.required':
          "JWT_SECRET is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"",
        'any.invalid': 'JWT_SECRET is a value published in the repository: generate a new one',
      }),
  }),
  // How long a sign-in lasts, e.g. "7d", "12h".
  JWT_EXPIRES_IN: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('7d'),
})
  // process.env holds many unrelated vars; report all errors at once.
  .unknown(true)
  .prefs({ abortEarly: false });
