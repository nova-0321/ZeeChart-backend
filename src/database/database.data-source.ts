import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.config.js';

export default new DataSource(
  buildDataSourceOptions((key) => process.env[key]),
);
