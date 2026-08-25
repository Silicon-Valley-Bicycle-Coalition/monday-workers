export interface SendLoginEmailParams {
  to: string;
  loginUrl: string;
}

export interface SendLetterReadyEmailParams {
  to: string;
  donorName: string;
  year: number;
  loginUrl: string;
}

export interface EmailSender {
  sendLoginEmail(params: SendLoginEmailParams): Promise<void>;
  sendLetterReadyEmail(params: SendLetterReadyEmailParams): Promise<void>;
}
