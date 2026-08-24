import type { Config } from '../config.js';

export function buildExtracts(cfg: Config): { name: string; soql: string; backupOnly?: boolean; paginate?: boolean }[] {
  return [
    { name: 'contacts', paginate: true, soql: `SELECT Id, FirstName, LastName, AccountId, Phone, MobilePhone,
        MailingStreet, MailingCity, MailingState, MailingPostalCode,
        Email, Primary_Email__c, Secondary_Email__c, Email_3__c, Email_4__c,
        npe01__HomeEmail__c, npe01__WorkEmail__c, npe01__AlternateEmail__c, npe01__Preferred_Email__c,
        Account.Do_Not_Solicit__c, Account.Do_Not_Solicit_What__c, dtd__company__c, funraise__fr_ID__c,
        Account.Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Contact` },
    { name: 'accounts', paginate: true, soql: `SELECT Id, Name, npe01__SYSTEM_AccountType__c, Type, Type_2__c, Industry,
        BillingStreet, BillingCity, BillingState, BillingPostalCode, Website, Phone,
        Do_Not_Solicit__c, Do_Not_Solicit_What__c,
        Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Account` },
    { name: 'opportunities', soql: `SELECT Id, Name, Amount, CloseDate, StageName, RecordType.Name,
        AccountId, npsp__Primary_Contact__c, CampaignId, funraise__fr_ID__c, funraise__fr_Donor__c,
        funraise__Subscription__c, funraise__Funraise_Pledge__c, CnP_PaaS__CnP_OrderNumber__c, dtd__company__c,
        Owner.Name, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name FROM Opportunity` },
    { name: 'payments', soql: `SELECT Id, npe01__Opportunity__c, npe01__Payment_Amount__c,
        npe01__Payment_Date__c, npe01__Paid__c FROM npe01__OppPayment__c` },
    { name: 'memberships', soql: `SELECT Id, Contact__c, Opportunity__c, Type__c, Start_Date__c,
        WEC_End_Date_Manual__c, CreatedDate FROM Membership__c` },
    { name: 'affiliations', soql: `SELECT Id, npe5__Contact__c, npe5__Organization__c, npe5__Role__c,
        npe5__Status__c FROM npe5__Affiliation__c` },
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
        funraise__Last_Name__c, funraise__Email__c, funraise__Fundraising_Event__c,
        funraise__Ticket_Amount__c, funraise__Ticket_Tax_Deductible_Amount__c, funraise__Attended__c,
        funraise__Transaction__c, CreatedDate, CreatedBy.Name, LastModifiedDate, LastModifiedBy.Name
        FROM funraise__Fundraising_Event_Registration__c` },
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
    { name: 'tasks_all', backupOnly: true, soql: `SELECT Id, WhoId, Subject, ActivityDate, Status,
        CreatedDate FROM Task` },
    { name: 'emails_all', backupOnly: true, soql: `SELECT Id, Subject, MessageDate, FromAddress,
        ToAddress FROM EmailMessage` },
    { name: 'eb4sf_attendees', backupOnly: true, soql: `SELECT Id, Name, eb4sf__Contact__c,
        eb4sf__Eventbrite_Event__c, eb4sf__Checked_In__c, CreatedDate FROM eb4sf__Eventbrite_Attendee__c` },
    { name: 'eb4sf_events', backupOnly: true, soql: `SELECT Id, Name, eb4sf__Start__c,
        CreatedDate FROM eb4sf__Eventbrite_Event__c` },
  ];
}
