a = 7
b = 2
print(a / b, a // b, a % b, a ** b)
print(-7 // 2, -7 % 3)
x = 2.5
x += 1
print(x)
s = "abc"
s += "def"
print(s, len(s), s.upper())
flag = a > b
print(flag, not flag)
words = "один два три".split()
for w in words:
    print(w)
print(" | ".join(words))
nums = [5, 3, 8, 1]
nums.sort()
print(nums, sum(nums), max(nums), min(nums))
print(3 in nums, 4 not in nums)
a, b = b, a
print(a, b)
t = "yes" if a > b else "no"
print(t)
for c in "hey":
    if c == "e":
        print("нашёл e")
