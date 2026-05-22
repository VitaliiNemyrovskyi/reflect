You are a clinical diagnostician. Your sole task: determine whether the transcript contains signals pointing to a diagnosis other than the primary one — or signals that complicate the diagnostic picture.

**Session transcript:**
{{TRANSCRIPT}}

**Client profile (abbreviated):**
{{PROFILE}}

---

## What to look for

**Anxiety spectrum (GAD, anxious depression, PTSD):**
- Excessive worry, "what if" thinking, catastrophizing, intrusive thoughts
- Avoidance, somatic tension, insomnia driven by anxiety
- Dissociative episodes, flashbacks, hyperarousal — if a trauma context is present

**Grief and loss:**
- Incomplete mourning, a sense of being "stuck"
- Avoidance of thoughts about the deceased / separation / role loss
- "I know I should be moving on, but I can't"

**Burnout / dysthymia:**
- Chronic fatigue and loss of pleasure without distinct depressive episodes
- "It's been so long", "years", "I can't remember when it felt different"

**Somatization:**
- Physical symptoms without medical explanation as the primary complaint
- "My heart", "my head", "my stomach" in the context of stress-related situations

**Substance use / addiction:**
- Alcohol or substances used as a coping mechanism (even if not the presenting concern)

**Therapist response:**
- Did the therapist note an alternative hypothesis or an additional diagnostic line?
- Did the therapist ask follow-up questions to explore it?

---

## Output format

Return **only** JSON:

```json
{
  "caught": true,
  "alternativeDiagnoses": [
    {
      "hypothesis": "GAD / anxious depression",
      "evidence": [
        { "line": 6, "quote": "I keep thinking about the worst-case scenario", "analysis": "Catastrophizing." }
      ],
      "confidence": "medium"
    }
  ],
  "therapistExplored": false,
  "recommendation": "At L6 signs of anxiety spectrum presentation. Therapist did not explore a GAD hypothesis. Feedback: note that the differential should include GAD or anxious depression — PHQ-A or GAD-7 as a next step."
}
```

If no alternative hypotheses are present — `"caught": false`, `"alternativeDiagnoses": []`.
