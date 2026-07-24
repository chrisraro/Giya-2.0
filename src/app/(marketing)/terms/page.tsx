import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | Giya",
  description: "The terms that govern your use of the Giya loyalty and rewards platform.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <LegalSection heading="The service">
        <p>
          Giya connects consumers and participating businesses through a receipt-based loyalty program. Consumers
          scan paper receipts from participating stores to earn points and rewards, and businesses use Giya to run
          their own loyalty campaigns. We may add, change, or discontinue features of the service at any time as we
          continue to develop it.
        </p>
      </LegalSection>

      <LegalSection heading="Accounts">
        <p>
          You must provide accurate information when creating your account and keep it up to date. Each person may
          hold only one account, and you are responsible for keeping your login credentials safe and confidential.
          You must be at least 18 years old to create an account, or have the consent of a parent or guardian if you
          are younger.
        </p>
      </LegalSection>

      <LegalSection heading="Earning points">
        <p>
          Points are awarded for genuine purchases evidenced by a valid receipt from a participating business. Every
          scanned receipt goes through our fraud and validity checks before points are credited, and we may reject a
          receipt that fails those checks. Once a receipt is approved, the resulting points are recorded in your
          account and reflected in your wallet.
        </p>
      </LegalSection>

      <LegalSection heading="Points are not money">
        <p>
          Points have no cash value. They cannot be transferred to another person or exchanged for cash, and they can
          only be redeemed for the rewards offered in the app. Points can expire according to the rules of each
          loyalty program, which are shown in the app before you redeem them.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <p>
          You may not submit fake, altered, borrowed, or duplicate receipts, and you may not use automation, bots, or
          any other method to scan receipts that are not your own genuine purchases. You also may not attempt to
          abuse or manipulate the points system in any other way. If you violate these rules, we may claw back points
          you were not entitled to, suspend your account, or terminate it.
        </p>
      </LegalSection>

      <LegalSection heading="Business participation">
        <p>
          Businesses that join Giya are responsible for honoring the rewards and loyalty programs they publish in
          the app. Businesses are also responsible for the accuracy of their own listings, including their offers,
          reward values, and program rules.
        </p>
      </LegalSection>

      <LegalSection heading="Liability">
        <p>
          The service is provided as is, without warranties beyond those required by law. To the extent permitted by
          applicable law, our liability to you is limited to the value of unredeemed rewards affected by an error we
          are responsible for.
        </p>
      </LegalSection>

      <LegalSection heading="Governing law">
        <p>
          These terms are governed by the laws of the Republic of the Philippines. Any dispute arising from these
          terms or your use of Giya will be brought in the proper courts of the operator&apos;s principal place of
          business.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          We may update these terms as our service or applicable law changes. If we make material changes, we will
          announce them in the app along with a fresh effective date, and your continued use of Giya after that date
          means you accept the updated terms.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
