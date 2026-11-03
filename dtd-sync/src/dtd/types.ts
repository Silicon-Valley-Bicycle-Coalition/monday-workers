export interface DtdDonation {
  donation_identifier: string; source: string | null; donation_datetime: string | null;
  donor_email: string | null; company_name: string | null; doublethedonation_company_id: string | number | null;
  status: string | null; matching_gift_status: string | null; employer_identification_status: string | null;
  matched_amount: number | null; plugin_link: string | null;
}

export interface DtdRegistration {
  campaign: string; donation_identifier: string; donation_amount: number; donation_datetime: string;
  donor_first_name: string; donor_last_name: string; donor_email: string; donor_phone?: string;
}
