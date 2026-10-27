import type { Config } from '../config.js';
import { WINDFALL_FIELDS } from '../transform/windfall.js';

export function buildExtracts(cfg: Config): { name: string; soql: string; backupOnly?: boolean; paginate?: boolean }[] {
  return [
    { name: 'contacts', paginate: true, soql: `SELECT Id, FirstName, LastName, AccountId, Phone, MobilePhone,
        MailingStreet, MailingCity, MailingState, MailingPostalCode,
        Email, Primary_Email__c, Secondary_Email__c, Email_3__c, Email_4__c,
        npe01__HomeEmail__c, npe01__WorkEmail__c, npe01__AlternateEmail__c, npe01__Preferred_Email__c,
        Account.Do_Not_Solicit__c, Account.Do_Not_Solicit_What__c, Employer__c, dtd__company__c, funraise__fr_ID__c, Elected__c,
        Do_Not_Mail__c, Do_Not_Mail_Reason__c, Deceased__c, npsp__Deceased__c,
        ${WINDFALL_FIELDS.join(', ')},
        Account.Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Contact` },
    { name: 'accounts', paginate: true, soql: `SELECT Id, Name, npe01__SYSTEM_AccountType__c, Type, Type_2__c, Industry,
        BillingStreet, BillingCity, BillingState, BillingPostalCode, Website, Phone,
        Do_Not_Solicit__c, Do_Not_Solicit_What__c,
        Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Account` },
    // Finance class/revenue code, payment method, check number, in-kind value/category and the
    // Funraise fee-coverage fields: added by the 2026-10-26 Opportunity audit (monday-migration
    // docs/32) — all in active use, none extracted before.
    { name: 'opportunities', paginate: true, soql: `SELECT Id, Name, Amount, CloseDate, StageName, RecordType.Name,
        AccountId, npsp__Primary_Contact__c, CampaignId, funraise__fr_ID__c, funraise__fr_Donor__c,
        funraise__Subscription__c, funraise__Funraise_Pledge__c, CnP_PaaS__CnP_OrderNumber__c, dtd__company__c,
        Finance_Class__c, Finance_Revenue_Code__c, Payment_Method__c, Check_Reference_Number__c,
        Retail_Value__c, In_Kind_Category__c, Funraise_Fee_Match_Opportunity__c, Funraise_Fee_Match_Amount__c,
        Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Opportunity` },
    // Descoped 2026-09-23 (issue #23): Opportunity Amount/CloseDate is the gift of record — it's
    // what NPSP's rollups summed and what Donations carries. 41,870 of 48,022 gifts have payments,
    // almost all one payment mirroring the gift; 123 split into installments and 422 disagree on
    // amount (mostly 2013–2017 entry noise). Kept in the backup archive, not transformed.
    { name: 'payments', backupOnly: true, paginate: true, soql: `SELECT Id, npe01__Opportunity__c,
        npe01__Payment_Amount__c, npe01__Payment_Date__c, npe01__Paid__c FROM npe01__OppPayment__c` },
    // Soft credits (~54k roles, ~45k of them the Primary Contact again) — transform keeps the
    // roles naming someone other than the gift's Primary Contact (donations.ts softCreditsByGift).
    { name: 'contact_roles', paginate: true, soql: `SELECT Id, OpportunityId, ContactId, Role, IsPrimary
        FROM OpportunityContactRole` },
    { name: 'memberships', soql: `SELECT Id, Contact__c, Opportunity__c, Type__c, Start_Date__c,
        WEC_End_Date_Manual__c, CreatedDate FROM Membership__c` },
    { name: 'affiliations', soql: `SELECT Id, npe5__Contact__c, npe5__Organization__c, npe5__Role__c,
        npe5__Status__c, npe5__StartDate__c, npe5__EndDate__c, npe5__Primary__c, npe5__Description__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM npe5__Affiliation__c` },
    { name: 'relationships', backupOnly: true, soql: `SELECT Id, npe4__Contact__c, npe4__RelatedContact__c,
        npe4__Type__c, npe4__Status__c FROM npe4__Relationship__c` },
    // ^ npe4 person↔person relationships (722 rows) have no decided Monday destination (docs 05/11
    // scope Affiliations only) — preserved in the backup archive; promoting them to a "Related
    // People" connect column is a possible follow-up decision, not v1 scope.
    { name: 'subscriptions', soql: `SELECT Id, Name, funraise__fr_ID__c, funraise__Supporter__c,
        funraise__Amount__c, funraise__Frequency__c, funraise__Status__c, funraise__Next_Payment_Date__c,
        funraise__Allocation_Name__c, funraise__Company_Match__c, funraise__Company_Match_Company_Name__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM funraise__Subscription__c` },
    { name: 'pledges', soql: `SELECT Id, funraise__Pledge_Subscription__c, funraise__Pledge_Amount__c,
        funraise__Received_Amount__c, funraise__Percent_Complete__c FROM funraise__Pledge__c` },
    { name: 'events', soql: `SELECT Id, Name, funraise__fr_ID__c, funraise__Start_Date__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM funraise__Fundraising_Event__c` },
    { name: 'registrations', soql: `SELECT Id, funraise__Registrant__c, funraise__First_Name__c,
        funraise__Last_Name__c, funraise__Email__c, funraise__Fundraising_Event__c, funraise__Ticket_Name__c,
        funraise__Ticket_Amount__c, funraise__Ticket_Tax_Deductible_Amount__c, funraise__Attended__c,
        funraise__Transaction__c, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM funraise__Fundraising_Event_Registration__c` },
    // Eventbrite history via the eb4sf ("Events Made Easy") managed package — promoted from
    // backup-only on 2026-09-08 (migration-plan.md, Eventbrite addendum): both platforms' events
    // land on the Events board, attendees on Event Registrations. ~284 events / ~6.3k attendees,
    // well under the CLI's 50k truncation ceiling, so no pagination needed.
    { name: 'eb4sf_events', soql: `SELECT Id, Name, eb4sf__Event_Name__c, eb4sf__Start__c, eb4sf__End__c,
        eb4sf__Status__c, eb4sf__Event_URL__c, eb4sf__Organizer_Name__c, eb4sf__Total_Tickets_Sold__c,
        eb4sf__Eventbrite_Venue__r.eb4sf__Name__c, eb4sf__Eventbrite_Venue__r.eb4sf__City__c,
        eb4sf__Eventbrite_Venue__r.eb4sf__Localized_Address_Display__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM eb4sf__Eventbrite_Event__c` },
    { name: 'eb4sf_attendees', soql: `SELECT Id, Name, eb4sf__First_Name__c, eb4sf__Last_Name__c, eb4sf__Email__c,
        eb4sf__Status__c, eb4sf__Checked_In__c, eb4sf__Cancelled__c, eb4sf__Ticket_Class_Name__c, eb4sf__Base_Price__c,
        eb4sf__Contact__c, eb4sf__Eventbrite_Event__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM eb4sf__Eventbrite_Attendee__c` },
    // The Eventbrite order behind each eb4sf ticket gift: the record Name is Eventbrite's order id.
    // Transform stamps it on the gift's Donations item as Eventbrite Order ID, so eventbrite-sync's
    // webhook and backfill adopt the migrated item instead of creating a second one. Only orders
    // linked to an Opportunity (~1.6k of ~5.7k) — the rest never became gifts.
    { name: 'eb4sf_orders', soql: `SELECT Id, Name, eb4sf__Opportunity__c, eb4sf__Event_Id__c, eb4sf__Status__c
        FROM eb4sf__Eventbrite_Order__c WHERE eb4sf__Opportunity__c != null` },
    { name: 'campaigns', soql: `SELECT Id, Name, RecordType.Name, StartDate, EndDate, IsActive,
        Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Campaign` },
    { name: 'clickpledge_transactions', soql: `SELECT Id, Name, CnP_PaaS__Contact__c, CnP_PaaS__Account__c,
        CnP_PaaS__TotalCharged__c, CnP_PaaS__TransactionDate__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM CnP_PaaS__CnP_Transaction__c` },
    { name: 'volunteer_hours', soql: `SELECT Id, GW_Volunteers__Contact__c, GW_Volunteers__Hours_Worked__c,
        GW_Volunteers__Start_Date__c, GW_Volunteers__Volunteer_Job__r.Name, GW_Volunteers__Status__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM GW_Volunteers__Volunteer_Hours__c` },
    { name: 'tasks_recent', soql: `SELECT Id, WhoId, Subject, ActivityDate, Status, Owner.Name,
        CreatedDate FROM Task WHERE ActivityDate >= ${cfg.activitySliceSinceISO}` },
    // backup-only artifacts (CSV-equivalent NDJSON in data/backup/)
    { name: 'contact_history', backupOnly: true, paginate: true, soql: `SELECT Id, ContactId, Field, OldValue, NewValue,
        CreatedById, CreatedDate FROM ContactHistory` },
    { name: 'campaign_members', backupOnly: true, paginate: true, soql: `SELECT Id, CampaignId, ContactId, Status,
        CreatedDate FROM CampaignMember` },
    { name: 'leads', backupOnly: true, soql: `SELECT Id, Name, Email, Status, IsConverted,
        Volunteer_How_Heard__c, Volunteer_Local_Team__c, CreatedDate FROM Lead` },
    { name: 'tasks_all', backupOnly: true, paginate: true, soql: `SELECT Id, WhoId, Subject, ActivityDate, Status,
        CreatedDate FROM Task` },
    { name: 'emails_all', backupOnly: true, soql: `SELECT Id, Subject, MessageDate, FromAddress,
        ToAddress FROM EmailMessage` },
    // Backup-only by decision 2026-09-30 (monday-migration #53): the sponsor benefit-fulfillment
    // engine (Sponsorship_Level__c → Sponsorship_Package__c → Sponsor_Benefit__c ← Benefit__c,
    // ~2,046 rows) and the Bike to Work Day logistics objects (BTWD_Order__c, Energizer_Station__c)
    // never land on a board. Field lists are the full custom set from docs/schema/svbc-custom.md
    // (private planning repo) plus Id/Name/record type/system dates — every object is well under
    // the CLI's 50k ceiling, so none is paginated.
    { name: 'sponsorship_levels', backupOnly: true, soql: `SELECT Id, Name, RecordType.Name,
        Additional_Free_Bike_Commuting_Workshop__c, Company_name_on_Annual_Dinner_event_sign__c,
        Company_name_on_Annual_Dinner_invitation__c, Company_name_on_Annual_dinner_program__c,
        Company_name_on_Bike_to_Work_Day_bags__c, Company_name_on_Bike_to_Work_Day_posters__c,
        Company_name_on_Bike_to_Work_Day_t_shirt__c, Free_BFW_consultation__c, Free_Bike_Commuting_Workshop__c,
        Highlighted_in_press_outreach_for_AD__c, Highlighted_in_press_outreach_for_BTWD__c,
        Invite_to_cmty_event_to_kick_off_Bike_Mo__c, Logo_and_full_page_profile_in_AD_program__c,
        Logo_and_profile_in_the_AD_program__c, Logo_Link_on_SVBC_website_for_one_year__c,
        Logo_on_Annual_Dinner_event_signage__c, Logo_on_Annual_Dinner_invitation__c, Logo_on_BACK_of_SVBC_Jersey__c,
        Logo_on_Bike_to_Work_Day_bags__c, Logo_on_Bike_to_Work_Day_posters__c, Logo_on_Bike_to_Work_Day_t_shirts__c,
        Logo_on_FRONT_of_SVBC_Jersey__c, Logo_on_SVBC_Jersey__c, Oppty_to_include_materials_in_BTWD_bags__c,
        Oppty_to_present_award_at_Annual_Dinner__c, Premium_table_for_10_at_Annual_Dinner__c,
        Presenting_sponsor_of_major_Annual_Event__c, Presenting_sponsor_of_minor_Annual_Event__c,
        Priority_placement_in_AD_media_opptys__c, Priority_placement_in_BTWD_media_opptys__c,
        RBTWD_Energizer_station_signage__c, RBTWD_FB_Thank_you_message__c, RBTWD_Log_on_BTWD_bags_at_regional_leve__c,
        RBTWD_Logo_on_event_posters_at_regional__c, RBTWD_Logo_on_regional_BTWD_website__c,
        RBTWD_Logo_on_t_shirts_at_regional_leve__c, RBTWD_Logo_on_TBC_flyer__c, RBTWD_Receive_BTWD_TY_package__c,
        RBTWD_Representation_in_PSA_Video__c, RBTWD_Representation_in_regional_media__c, RBTWD_Twitter_thank_you_tweet__c,
        Social_media_FB_likes_Twitter_follows__c, Summit_1_Ticket_for_event__c, Summit_10_Tickets_for_event__c,
        Summit_2_pre_event_blogs__c, Summit_2_Tickets_for_event__c, Summit_4_Tickets_for_event__c,
        Summit_6_Tickets_for_event__c, Summit_8_Tickets_for_event__c, Summit_Branded_giveaway__c,
        Summit_e_Bulletin_recognition_of_sponso__c, Summit_Full_page_representation_in_conf__c,
        Summit_Half_page_representation_in_conf__c, Summit_Logo_in_conference_program__c, Summit_Logo_placement_on_signs__c,
        Summit_Onstage_role__c, Summit_Opportunity_to_present_or_modera__c, Summit_Oppty_to_partake_in_vendor_expo__c,
        Summit_Premiere_logo_placement_on_event__c, Summit_Recognition_link_on_SVBC_website__c,
        Summit_Social_media_mentions_tags__c, Summit_Verbal_recognition_from_podium__c, Table_for_10_at_Annual_Dinner__c,
        X1_SVBC_Jersey__c, X10_SVBC_Jerseys__c, X2_Link_to_SVBC_sponsor_pg_in_e_Bulletin__c, X2_SVBC_Jerseys__c,
        X2_Tickets_to_Annual_Dinner__c, X2_Tickets_to_Annual_Dinner_VIP_receptio__c, X25_One_year_complimentary_memberships__c,
        X4_SVBC_Jerseys__c, X4_Tickets_to_Annual_Dinner_VIP_receptio__c, X4_Tickets_to_the_Annual_Dinner__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Sponsorship_Level__c` },
    { name: 'sponsorship_packages', backupOnly: true, soql: `SELECT Id, Name, Account__c, Opportunity__c,
        Sponsorship_Level__c, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM Sponsorship_Package__c` },
    { name: 'sponsor_benefits', backupOnly: true, soql: `SELECT Id, Name, Account__c, Available__c, Benefit__c,
        Campaign__c, Major_Annual_Event__c, Minor_Annual_Event__c, Opportunity__c, Present_Award__c, Redeemed__c,
        Sponsorship_Package__c, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM Sponsor_Benefit__c` },
    { name: 'benefits', backupOnly: true, soql: `SELECT Id, Name, Available__c, Campaign__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Benefit__c` },
    { name: 'btwd_orders', backupOnly: true, soql: `SELECT Id, Name, RecordType.Name, Energizer_Station__c,
        Bag_Amount_Due__c, BTWD_Bag_Total_del__c, Cake_Half_Sheets__c, English_11x17__c, English_8_5x11__c,
        Men_s_2XL__c, Men_s_L__c, Men_s_M__c, Men_s_S__c, Men_s_XL__c, Men_s_XS__c,
        Musette_Total__c, Musette_Unit_Price__c, Number_of_Free_Shirts__c, Number_of_Musettes__c, Number_of_Totes__c,
        Pick_Up_Location_Time__c, Poster_Order_Status__c, Receiving_t_shirts_how__c, Shipping_fees__c,
        Shirt_Grand_Total__c, Shirt_Sub_Total__c, Spanish_8_5x11__c, Total_of_Shirts__c, Total_Poster_Count__c,
        Tote_Total__c, Tote_Unit_Price__c, Unit_Price_per_Shirt__c, Vietnamese_8_5x11__c,
        Women_s_2XL__c, Women_s_L__c, Women_s_M__c, Women_s_S__c, Women_s_XL__c, Women_s_XS__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM BTWD_Order__c` },
    { name: 'energizer_stations', backupOnly: true, soql: `SELECT Id, Name, Host_Organization__c,
        Energizer_Station_Lead__c, E_Station_Lead_Email__c, Lead_Phone__c, Primary_Campaign_Source_del__c, Luncheon__c,
        Date_of_Energizer__c, Engergizer_Start__c, Energizer_End__c, Status__c, Status_Reason__c,
        Energizer_Description__c, BTWD_Orders_Only__c, Received_Emails__c, Same_as_Location__c,
        Location_Business_Name__c, Location_Street__c, Location_City__c, Location_State__c, Location_Zip_Code__c,
        ES_Mailing_Street__c, ES_Mailing_City__c, ES_Mailing_State__c, ES_Mailing_Zip_Code__c,
        Bikes_Passed__c, Bikes_Stopped__c, Total_Bikes_Counted__c,
        CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Energizer_Station__c` },
  ];
}
