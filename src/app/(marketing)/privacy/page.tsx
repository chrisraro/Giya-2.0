import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | Giya",
  description: "How Giya collects, uses, and protects your personal data under the Philippine Data Privacy Act.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <LegalSection heading="Who we are">
        <p>
          Giya operates a loyalty and rewards platform that connects consumers with participating food and retail
          businesses in the Philippines. This policy explains what personal data we collect, why we collect it, and
          how we protect it when you use the Giya app or website. If you have questions about this policy or how we
          handle your data, contact us at teamocsph@gmail.com.
        </p>
      </LegalSection>

      <LegalSection heading="What we collect">
        <p>
          When you create an account, we collect your name, email address, and optionally your phone number and
          birth date. When you scan a receipt, we collect the receipt image and the purchase details extracted from
          it, such as the store, date, items, and amount. We also collect device and app-usage information, such as
          your device type and how you interact with the app, to keep the service working and secure. If you sign up
          as a business, we collect the business documents needed to verify that the business is real and eligible
          to join.
        </p>
      </LegalSection>

      <LegalSection heading="Why we collect it">
        <p>
          We use your data to award points accurately for genuine purchases and to run the loyalty programs that
          businesses publish in the app. We also use it to prevent fraud, including checking receipts for
          authenticity and applying velocity limits to catch unusual scanning activity. We will only use your data
          to send you marketing communications if you have separately opted in to receive them.
        </p>
      </LegalSection>

      <LegalSection heading="Consent and marketing">
        <p>
          Marketing communications, such as promotional emails or push notifications about offers, are always
          opt-in and are kept separate from your acceptance of our terms of service. Using Giya does not require you
          to receive marketing messages. You can withdraw your marketing consent at any time from your account
          settings in the app, and we will stop sending those messages once your preference is updated.
        </p>
      </LegalSection>

      <LegalSection heading="Who can see your data">
        <p>
          The businesses you scan receipts at can see your activity with them, such as your display name, visit
          history, and points balance, so they can run their loyalty program and honor your rewards. Businesses do
          not see your contact details, such as your email or phone number, unless you separately choose to share
          them. We do not sell your personal data to anyone, and we only share data with service providers who help
          us run Giya, under agreements that require them to protect it.
        </p>
      </LegalSection>

      <LegalSection heading="Your rights (RA 10173)">
        <p>
          Under the Data Privacy Act of 2012 (Republic Act 10173), you have the right to access, correct, and
          request deletion of your personal data, and to request a copy of it in a portable format. You can exercise
          these rights by emailing teamocsph@gmail.com. Because points live in an append-only ledger that keeps our
          financial records accurate, a deletion request anonymizes your ledger entries instead of erasing them
          outright. If you believe we have not handled your data properly, you may also file a complaint with the
          National Privacy Commission.
        </p>
      </LegalSection>

      <LegalSection heading="Retention and security">
        <p>
          We keep your personal data only for as long as your account is active, plus any additional period required
          by law, such as tax or accounting rules. We protect data with encryption both while it is being transmitted
          and while it is stored. Sensitive identifiers, such as a business&apos;s tax identification number or government
          issued IDs submitted for verification, are stored encrypted.
        </p>
      </LegalSection>

      <LegalSection heading="Location data">
        <p>
          Giya does not track your location in the background. GPS coordinates are attached to a receipt scan only
          when you opt in to share your location, and we use that location solely to help our fraud checks confirm
          that a scan is genuine.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          We may update this privacy policy from time to time as our services change or as the law requires. If we
          make material changes, we will announce them in the app before they take effect. Continuing to use Giya
          after an updated policy&apos;s effective date means you accept the changes.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
