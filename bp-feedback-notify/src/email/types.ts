export interface SendFeedbackRequestEmailParams {
  to: string;
  eventName: string;
  feedbackFormUrl: string;
}

export interface EmailSender {
  sendFeedbackRequestEmail(params: SendFeedbackRequestEmailParams): Promise<void>;
}
