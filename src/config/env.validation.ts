import Joi from 'joi';

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

  // Signs the sign-in tokens. Required (32+ characters) in production; elsewhere a fixed
  // development value is used when unset, so a fresh checkout (and CI) still starts. Changing it
  // signs everyone out.
  JWT_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(16).default('zeechart-development-secret-not-for-production'),
  }),
  // How long a sign-in lasts, e.g. "7d", "12h".
  JWT_EXPIRES_IN: Joi.string()
    .pattern(/^\d+[smhd]$/)
    .default('7d'),
})
  // process.env holds many unrelated vars; report all errors at once.
  .unknown(true)
  .prefs({ abortEarly: false });
