import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';

interface ErrorInfo {
  status: number;
  message: string | string[];
}

// Postgres error codes we turn into friendly client errors.
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * Every error leaves the API in one shape:
 *   { statusCode, error, message, path, timestamp }
 * `message` is a string, or a string[] for validation errors.
 * Database errors are mapped to 4xx where the client caused them; anything
 * unknown becomes a generic 500 so internals never leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ url: string }>();

    const { status, message } = this.toErrorInfo(exception);

    if (status >= 500) {
      this.logger.error(
        `${httpAdapter.getRequestMethod(request)} ${httpAdapter.getRequestUrl(request)}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.reply(
      ctx.getResponse(),
      {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        message,
        path: httpAdapter.getRequestUrl(request),
        timestamp: new Date().toISOString(),
      },
      status,
    );
  }

  private toErrorInfo(exception: unknown): ErrorInfo {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      return { status: exception.getStatus(), message };
    }

    // repository.findOneByOrFail(...) and friends
    if (exception instanceof EntityNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, message: 'Resource not found' };
    }

    if (exception instanceof QueryFailedError) {
      const driverError = exception.driverError as {
        code?: string;
        detail?: string;
      };
      switch (driverError.code) {
        case PG_UNIQUE_VIOLATION:
          return {
            status: HttpStatus.CONFLICT,
            message: 'A record with the same unique value already exists',
          };
        case PG_FOREIGN_KEY_VIOLATION:
          return {
            status: HttpStatus.CONFLICT,
            message: 'The record references, or is referenced by, another record',
          };
        case PG_NOT_NULL_VIOLATION:
          return { status: HttpStatus.BAD_REQUEST, message: 'A required value is missing' };
        case PG_INVALID_TEXT_REPRESENTATION:
          return { status: HttpStatus.BAD_REQUEST, message: 'A value has an invalid format' };
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
