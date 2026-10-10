/** The signed-in user, as the app sees it (no password hash). */
export class AuthUserDto {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

/** What sign-up and sign-in answer: the token to send as `Authorization: Bearer`, and the user. */
export class AuthResponseDto {
  accessToken: string;
  user: AuthUserDto;
}
